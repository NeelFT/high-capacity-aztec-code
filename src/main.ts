import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { drawAztecFrame, MAX_FILE_BYTES, prepareAztecTransfer } from './aztec';
import type { PreparedAztecTransfer } from './aztec';
import type { DecoderTrace } from './image-decoder';
import type { WorkerRequest, WorkerResponse } from './worker-protocol';

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
      .catch((error: unknown) => console.error('Unable to register the offline app worker.', error));
  });
}

const MATRIX_SIZE = 32;
const SCAN_MAX_SIDE = 360;
const SCAN_FRAME_QUEUE_LIMIT = 4;
const SCAN_CAPTURE_INTERVAL = 1000 / 60;
const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const sendButton = document.getElementById('sendButton') as HTMLButtonElement;
const fileName = document.getElementById('sendFileName') as HTMLElement;
const sendStatus = document.getElementById('sendStatus') as HTMLElement;
const sendFileDetails = document.getElementById('sendFileDetails') as HTMLElement;
const canvas = document.getElementById('tx') as HTMLCanvasElement;
const camera = document.getElementById('camera') as HTMLVideoElement;
const cameraCanvas = document.getElementById('scanCanvas') as HTMLCanvasElement;
const startButton = document.getElementById('startButton') as HTMLButtonElement;
const receiveStatus = document.getElementById('receiveStatus') as HTMLElement;
const receiveProgress = document.getElementById('receiveProgress') as HTMLProgressElement;
const receiveProgressText = document.getElementById('receiveProgressText') as HTMLElement;
const receiveFileName = document.getElementById('receiveFileName') as HTMLElement;
const cameraOverlay = document.querySelector<SVGSVGElement>('#cameraOverlay')!;
const cameraOutline = document.querySelector<SVGPolygonElement>('#cameraOutline')!;
const cameraBullseye = document.querySelector<SVGPolygonElement>('#cameraBullseye')!;
const cameraReadoutState = document.getElementById('cameraReadoutState') as HTMLElement;
const cameraReadoutCounts = document.getElementById('cameraReadoutCounts') as HTMLElement;
const transferComplete = document.getElementById('transferComplete') as HTMLElement;
const exportFileButton = document.getElementById('exportFileButton') as HTMLButtonElement;
const sendPanel = document.getElementById('sendPanel') as HTMLElement;
const receivePanel = document.getElementById('receivePanel') as HTMLElement;
const sendTab = document.getElementById('sendTab') as HTMLButtonElement;
const receiveTab = document.getElementById('receiveTab') as HTMLButtonElement;
const zoomSlider = document.getElementById('zoomSlider') as HTMLInputElement;
const zoomHelp = document.getElementById('zoomHelp') as HTMLElement;

let transfer: PreparedAztecTransfer | null = null;
let prepareGeneration = 0;
let sending = false;
let stream: MediaStream | null = null;
let worker: Worker | null = null;
let scanTimer = 0;
let videoFrameCallback = 0;
let frameInFlight = false;
const queuedScanFrames: ImageData[] = [];
let lastScanCaptureTime = 0;
let activeZoomTrack: MediaStreamTrack | null = null;
let receiverGeneration = 0;
let senderGeneration = 0;
let verifiedReceivedFile: { bytes: Uint8Array; name: string; mime: string } | null = null;

type ZoomCapabilities = MediaTrackCapabilities & { zoom?: { min: number; max: number; step?: number } };
type ZoomConstraints = MediaTrackConstraints & { advanced?: Array<MediaTrackConstraintSet & { zoom?: number }> };

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

function stopSender(): void {
  if (sending) {
    sending = false;
    senderGeneration += 1;
  }
  if (!fileInput.disabled) return;
  fileInput.disabled = false;
  sendButton.textContent = 'Send';
}

function setMode(mode: 'send' | 'receive'): void {
  const receiving = mode === 'receive';
  sendPanel.hidden = receiving;
  receivePanel.hidden = !receiving;
  sendTab.classList.toggle('active', !receiving);
  receiveTab.classList.toggle('active', receiving);
  sendTab.setAttribute('aria-selected', String(!receiving));
  receiveTab.setAttribute('aria-selected', String(receiving));
  if (receiving) {
    stopSender();
  } else {
    stopReceiver();
  }
}

function setCameraZoomAvailability(): void {
  const track = stream?.getVideoTracks()[0] ?? null;
  activeZoomTrack = track;
  const zoom = (track?.getCapabilities() as ZoomCapabilities | undefined)?.zoom;
  if (!zoom) {
    zoomSlider.disabled = true;
    zoomHelp.textContent = 'Move closer to the screen if the image is hard to read.';
    return;
  }
  zoomSlider.min = String(zoom.min);
  zoomSlider.max = String(zoom.max);
  zoomSlider.step = String(zoom.step ?? 0.1);
  zoomSlider.value = String(zoom.min);
  zoomSlider.disabled = false;
  zoomHelp.textContent = 'Use the zoom control if needed.';
}

async function applyCameraZoom(): Promise<void> {
  if (!activeZoomTrack) return;
  try {
    const constraints: ZoomConstraints = { advanced: [{ zoom: Number(zoomSlider.value) }] };
    await activeZoomTrack.applyConstraints(constraints);
  } catch (error) {
    console.error('Could not adjust the camera zoom.', error);
    zoomSlider.disabled = true;
    zoomHelp.textContent = 'Move closer to the screen if the image is hard to read.';
  }
}

function updateScanStatus(trace: Omit<DecoderTrace, 'packet'>): void {
  updateCameraOverlay(trace);
  cameraReadoutState.textContent = trace.status === 'packet-decoded'
    ? 'FRAME READ'
    : trace.candidateCount > 0 || trace.trackedCandidate || trace.geometryCandidates > 0
      ? 'QR DETECTED'
      : 'SEARCHING';
  if (trace.status === 'packet-decoded') {
    setReceiveStatus('Colorful code found—receiving file.', 'receiving');
  } else if (trace.gridSampled) {
    setReceiveStatus('Colorful code found—reading data. Keep both screens steady.', 'detected');
  } else if (trace.orientationFound) {
    setReceiveStatus('Colorful code found—hold the image steady.', 'detected');
  } else if (trace.geometryCandidates > 0) {
    setReceiveStatus('Code spotted—hold it steady while I line it up.', 'detected');
  } else if (trace.candidateCount > 0) {
    setReceiveStatus('Possible code spotted—move closer and hold steady.', 'detected');
  } else if (trace.trackedCandidate) {
    setReceiveStatus('Still looking at the code—hold steady and keep the whole image in view.', 'detected');
  } else {
    setReceiveStatus('Looking for the colorful code…', 'searching');
  }
}

function updateCameraOverlay(trace: Omit<DecoderTrace, 'packet'>): void {
  const width = camera.videoWidth;
  const height = camera.videoHeight;
  if (!width || !height) {
    cameraOutline.setAttribute('visibility', 'hidden');
    cameraBullseye.setAttribute('visibility', 'hidden');
    return;
  }
  cameraOverlay.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const sourceSize = Math.min(width, height);
  const cropX = Math.floor((width - sourceSize) / 2);
  const cropY = Math.floor((height - sourceSize) / 2);
  const scale = sourceSize / trace.imageWidth;
  if (trace.corners) {
    const points = trace.corners
      .map((point) => `${point.x * scale + cropX},${point.y * scale + cropY}`)
      .join(' ');
    cameraOutline.setAttribute('points', points);
    cameraOutline.setAttribute('visibility', 'visible');
  } else {
    cameraOutline.setAttribute('visibility', 'hidden');
  }
  if (trace.finderCorners) {
    const points = trace.finderCorners
      .map((point) => `${point.x * scale + cropX},${point.y * scale + cropY}`)
      .join(' ');
    cameraBullseye.setAttribute('points', points);
    cameraBullseye.setAttribute('visibility', 'visible');
  } else {
    cameraBullseye.setAttribute('visibility', 'hidden');
  }
  cameraOverlay.dataset.scanState = trace.status === 'packet-decoded'
    ? 'receiving'
    : trace.candidateCount > 0 || trace.trackedCandidate || trace.geometryCandidates > 0
      ? 'detected'
      : 'searching';
}

function updateReceiveProgress(qrCodesRead: number, recoveredBlocks: number, requiredBlocks: number): void {
  receiveProgress.hidden = false;
  receiveProgress.max = requiredBlocks;
  receiveProgress.value = recoveredBlocks;
  receiveProgressText.textContent = `Unique QR codes read: ${qrCodesRead}. Data blocks recovered: ${recoveredBlocks} of ${requiredBlocks}.`;
  cameraReadoutCounts.textContent = `QR ${qrCodesRead} · DATA ${recoveredBlocks}/${requiredBlocks}`;
}

function setReceiveStatus(text: string, scanState?: 'searching' | 'detected' | 'receiving'): void {
  receiveStatus.textContent = text;
  if (scanState) receiveStatus.dataset.scanState = scanState;
  else delete receiveStatus.dataset.scanState;
}

function scheduleScan(): void {
  if (!stream || !worker) return;
  if ('requestVideoFrameCallback' in camera) {
    videoFrameCallback = camera.requestVideoFrameCallback(() => {
      videoFrameCallback = 0;
      scan();
    });
  } else {
    scanTimer = requestAnimationFrame(scan);
  }
}

function processNextScanFrame(): void {
  if (!stream || !worker || frameInFlight || queuedScanFrames.length === 0) return;
  const image = queuedScanFrames.shift();
  if (!image) return;
  frameInFlight = true;
  try {
    const request: WorkerRequest = { type: 'frame', pixels: image };
    worker.postMessage(request, [image.data.buffer]);
  } catch (error) {
    console.error('Could not send the camera image to the decoder.', error);
    setReceiveStatus('Could not process the camera image. Please try again.');
    stopReceiver();
  }
}

function scan(timestamp?: number): void {
  if (!stream || !worker) return;
  scheduleScan();
  if (timestamp !== undefined) {
    if (timestamp - lastScanCaptureTime < SCAN_CAPTURE_INTERVAL) return;
    lastScanCaptureTime = timestamp;
  }
  if (camera.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || camera.videoWidth === 0 || camera.videoHeight === 0) return;
  const sourceSize = Math.min(camera.videoWidth, camera.videoHeight);
  const scanSize = Math.min(sourceSize, SCAN_MAX_SIDE);
  if (cameraCanvas.width !== scanSize || cameraCanvas.height !== scanSize) {
    cameraCanvas.width = scanSize;
    cameraCanvas.height = scanSize;
  }
  const context = cameraCanvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    setReceiveStatus('Camera preview is unavailable.');
    stopReceiver();
    return;
  }
  const cropX = Math.floor((camera.videoWidth - sourceSize) / 2);
  const cropY = Math.floor((camera.videoHeight - sourceSize) / 2);
  try {
    context.drawImage(camera, cropX, cropY, sourceSize, sourceSize, 0, 0, scanSize, scanSize);
    const image = context.getImageData(0, 0, scanSize, scanSize);
    if (queuedScanFrames.length === SCAN_FRAME_QUEUE_LIMIT) queuedScanFrames.shift();
    queuedScanFrames.push(image);
    processNextScanFrame();
  } catch (error) {
    console.error('Could not read the camera image.', error);
    setReceiveStatus('Could not read the camera image. Please try again.');
    stopReceiver();
    return;
  }
}

function stopReceiver(): void {
  receiverGeneration += 1;
  if (scanTimer) cancelAnimationFrame(scanTimer);
  if (videoFrameCallback) camera.cancelVideoFrameCallback(videoFrameCallback);
  scanTimer = 0;
  videoFrameCallback = 0;
  queuedScanFrames.length = 0;
  lastScanCaptureTime = 0;
  worker?.postMessage({ type: 'stop' } satisfies WorkerRequest);
  worker?.terminate();
  worker = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  camera.srcObject = null;
  activeZoomTrack = null;
  zoomSlider.disabled = true;
  frameInFlight = false;
  cameraOutline.setAttribute('visibility', 'hidden');
  cameraBullseye.setAttribute('visibility', 'hidden');
  cameraReadoutState.textContent = 'SEARCHING';
  cameraReadoutCounts.textContent = 'QR 0 · DATA 0/—';
  cameraOverlay.dataset.scanState = 'searching';
  startButton.textContent = 'Start camera';
}

function resetReceiveState(): void {
  verifiedReceivedFile = null;
  frameInFlight = false;
  transferComplete.hidden = true;
  exportFileButton.hidden = true;
  receiveFileName.textContent = '';
  receiveProgress.hidden = true;
  receiveProgress.value = 0;
  receiveProgressText.textContent = 'Waiting to detect a QR code.';
  cameraOutline.setAttribute('visibility', 'hidden');
  cameraBullseye.setAttribute('visibility', 'hidden');
  cameraReadoutState.textContent = 'SEARCHING';
  cameraReadoutCounts.textContent = 'QR 0 · DATA 0/—';
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 49_152;
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))));
  }
  return chunks.join('');
}

async function exportVerifiedFile(file: { bytes: Uint8Array; name: string; mime: string }): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    const blobBytes = new Uint8Array(file.bytes.length);
    blobBytes.set(file.bytes);
    const url = URL.createObjectURL(new Blob([blobBytes.buffer], { type: file.mime }));
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setReceiveStatus('File received and downloaded.');
    return;
  }

  exportFileButton.disabled = true;
  let temporaryPath: string | null = null;
  try {
    const safeName = file.name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/^\.+$/, '_') || 'received-file';
    const filePath = `received-${Date.now()}-${safeName}`;
    const savedFile = await Filesystem.writeFile({
      path: filePath,
      data: bytesToBase64(file.bytes),
      directory: Directory.Cache,
    });
    temporaryPath = filePath;
    await Share.share({
      title: file.name,
      files: [savedFile.uri],
      dialogTitle: 'Save or share received file',
    });
    setReceiveStatus('File received. Choose where to save or share it.');
  } catch (error) {
    console.error('Could not export the received file.', error);
    setReceiveStatus('File received, but it could not be saved. Tap the button to try again.');
  } finally {
    if (temporaryPath) {
      try {
        await Filesystem.deleteFile({ path: temporaryPath, directory: Directory.Cache });
      } catch (error) {
        console.error('Could not remove the temporary received file.', error);
      }
    }
    exportFileButton.disabled = false;
  }
}

function downloadCompletedFile(message: Extract<WorkerResponse, { type: 'complete' }>): void {
  updateReceiveProgress(message.unique, message.solved, message.blockCount);
  if (!message.verified || !/^[\da-f]{64}$/i.test(message.expectedHash)) {
    setReceiveStatus('The file may not have arrived correctly. Please scan again.');
    stopReceiver();
    return;
  }
  verifiedReceivedFile = {
    bytes: new Uint8Array(message.bytes),
    name: message.name || 'received-file',
    mime: message.mime || 'application/octet-stream',
  };
  receiveFileName.textContent = verifiedReceivedFile.name;
  transferComplete.hidden = false;
  exportFileButton.hidden = !Capacitor.isNativePlatform();
  setReceiveStatus(Capacitor.isNativePlatform()
    ? 'File received. Opening save and share options…'
    : 'File received and downloaded.');
  stopReceiver();
  void exportVerifiedFile(verifiedReceivedFile);
}

function handleWorkerMessage(message: WorkerResponse): void {
  if (message.type === 'packet') {
    if (message.name) receiveFileName.textContent = message.name;
    updateReceiveProgress(message.decodedCount, message.solved, message.blockCount);
    cameraReadoutState.textContent = 'FRAME SAVED';
    setReceiveStatus('Collecting QR frames. The file will be rebuilt as enough data arrives.', 'receiving');
    return;
  }
  if (message.type === 'diagnostic') {
    updateScanStatus(message.trace);
    return;
  }
  if (message.type === 'frameDone') {
    frameInFlight = false;
    processNextScanFrame();
    return;
  }
  if (message.type === 'complete') {
    downloadCompletedFile(message);
    return;
  }
  console.error('The receiver could not finish this transfer.', message.message);
  setReceiveStatus('Could not receive the file. Keep both screens steady and try again.');
  stopReceiver();
}

async function prepareSelectedFile(file: File): Promise<void> {
  const generation = ++prepareGeneration;
  transfer = null;
  sendButton.disabled = true;
  fileName.textContent = file.name;
  sendFileDetails.textContent = `${formatFileSize(file.size)} · Calculating QR count…`;
  sendStatus.textContent = 'Preparing your file…';
  try {
    if (file.size > MAX_FILE_BYTES) throw new Error('This file is too large to send.');
    const prepared = await prepareAztecTransfer(file, MATRIX_SIZE);
    if (generation !== prepareGeneration) return;
    transfer = prepared;
    sendFileDetails.textContent = `${formatFileSize(file.size)} · ${prepared.frameCount} QR codes`;
    sendStatus.textContent = 'Ready to send.';
    sendButton.disabled = false;
  } catch (error) {
    if (generation !== prepareGeneration) return;
    console.error('Could not prepare the selected file.', error);
    sendFileDetails.textContent = `${formatFileSize(file.size)} · QR count unavailable`;
    sendStatus.textContent = 'Could not prepare this file. Try a different file.';
  }
}

fileInput.onchange = () => {
  const file = fileInput.files?.[0];
  if (file) void prepareSelectedFile(file);
};

sendButton.onclick = async () => {
  if (sending) {
    stopSender();
    sendStatus.textContent = 'Ready to send.';
    return;
  }
  if (!transfer) return;
  const activeTransfer = transfer;
  const generation = ++senderGeneration;
  sending = true;
  fileInput.disabled = true;
  sendButton.textContent = 'Stop';
  let index = 0;
  try {
    while (sending && generation === senderGeneration) {
      const packet = activeTransfer.packets[index];
      drawAztecFrame(packet, canvas, activeTransfer.targetMatrixSize);
      sendStatus.textContent = `Sending QR ${index + 1} of ${activeTransfer.frameCount}…`;
      index = (index + 1) % activeTransfer.packets.length;
      const holdMs = Math.max(220, Math.round(220 * Math.pow(activeTransfer.targetMatrixSize / 63, 1.35)));
      await new Promise<void>((resolve) => window.setTimeout(resolve, holdMs));
    }
  } catch (error) {
    console.error('Could not display the transfer.', error);
    sendStatus.textContent = 'Could not send this file. Please try again.';
  } finally {
    if (generation !== senderGeneration) return;
    sending = false;
    fileInput.disabled = false;
    sendButton.textContent = 'Send';
    if (sendStatus.textContent.startsWith('Sending QR ')) sendStatus.textContent = 'Ready to send.';
  }
};

canvas.addEventListener('click', () => {
  if (sending) stopSender();
});

startButton.onclick = async () => {
  if (stream) {
    stopReceiver();
    setReceiveStatus('Camera stopped.');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setReceiveStatus('Camera access is unavailable. Try opening the app in a supported browser.');
    return;
  }
  const generation = ++receiverGeneration;
  startButton.disabled = true;
  setReceiveStatus('Starting camera…');
  try {
    const acquiredStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        frameRate: { ideal: 120 },
      },
      audio: false,
    });
    if (generation !== receiverGeneration || receivePanel.hidden) {
      acquiredStream.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = acquiredStream;
    camera.srcObject = acquiredStream;
    await camera.play();
    if (generation !== receiverGeneration || receivePanel.hidden) return;
    worker = new Worker(new URL('./decoder.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => handleWorkerMessage(event.data);
    worker.onerror = (event: ErrorEvent) => {
      console.error('The receiver stopped unexpectedly.', event.message);
      setReceiveStatus('The camera stopped unexpectedly. Please try again.');
      stopReceiver();
    };
    resetReceiveState();
    for (const track of acquiredStream.getVideoTracks()) {
      track.addEventListener('ended', () => {
        setReceiveStatus('Camera stopped.');
      }, { once: true });
    }
    setCameraZoomAvailability();
    setReceiveStatus('Looking for the colorful code. Point the camera at the sender’s screen.', 'searching');
    startButton.textContent = 'Stop camera';
    worker.postMessage({ type: 'start', targetMatrixSize: MATRIX_SIZE } satisfies WorkerRequest);
    scan();
  } catch (error) {
    if (generation !== receiverGeneration) return;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    worker?.terminate();
    worker = null;
    camera.srcObject = null;
    console.error('Could not start the camera.', error);
    const errorName = error instanceof DOMException ? error.name : '';
    const hint = errorName === 'NotAllowedError'
      ? 'Allow camera access to scan a transfer.'
      : errorName === 'NotFoundError'
        ? 'No camera was found on this device.'
        : errorName === 'NotReadableError'
          ? 'Close other apps using the camera and try again.'
          : 'Could not start the camera. Please try again.';
    setReceiveStatus(hint);
    startButton.textContent = 'Start camera';
  } finally {
    startButton.disabled = false;
  }
};

zoomSlider.oninput = () => { void applyCameraZoom(); };
exportFileButton.onclick = () => {
  if (verifiedReceivedFile) void exportVerifiedFile(verifiedReceivedFile);
};
sendTab.onclick = () => setMode('send');
receiveTab.onclick = () => setMode('receive');
window.addEventListener('beforeunload', () => {
  stopSender();
  stopReceiver();
});
setMode('send');
