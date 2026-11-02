# High Capacity Aztec Code

A small experiment in moving a file from one screen to another with light. The app turns a file into a repeating stream of color-coded, Aztec-style frames. A second device watches that stream with its camera, rebuilds the file from the packets it can read, and downloads it when the transfer is complete.

This is a custom visual-transfer format, not a standard Aztec barcode reader. It does not send the file over Wi-Fi or through a server; the data travels in the changing colors on the sender's screen.

The sender and receiver must use the same matrix size. Transfers are limited to 16 MiB and may be further limited by the selected matrix's packet capacity and the protocol's block-count limit. Every packet is checked with CRC32, and the receiver only downloads the reconstructed file after its SHA-256 digest matches the sender's metadata.
File names and MIME types are limited to 120 UTF-8 bytes each; files with longer metadata are rejected rather than renamed or relabeled during transfer.

## Try it locally

You need Node.js 20.19 or newer.

```sh
npm ci
npm run dev
```

Open the **Network** HTTPS address printed by Vite on each device (for example, `https://192.168.1.20:5173/`), not `localhost` on the phone. The server binds to all network interfaces on the fixed port 5173; Vite exits with a clear error if that port is already in use rather than silently switching to a port that may not be allowed through the firewall. The development certificate includes the computer's current LAN addresses. It is not issued by a public certificate authority, so each device must trust or proceed past the development-certificate warning before the browser will load the page. Camera access requires HTTPS (or `localhost`).

## Install on a phone

Open the hosted app at https://neelft.github.io/high-capacity-aztec-code/ using your phone's browser. On Android, use the browser menu and select **Install app** (or **Add to Home screen**). On iPhone, open the Share menu in Safari and select **Add to Home Screen**. The app shell and static assets are cached for offline launch after the first visit; camera access and file sharing still depend on browser and device support.

### Download the offline Android app

[Download the HCAC-OFT APK](https://github.com/NeelFT/high-capacity-aztec-code/raw/refs/heads/main/downloads/HCAC-OFT-v1.0-debug.apk?download=1). This debug-signed APK includes the app locally and works offline; it needs camera permission to scan transfers and does not require internet access. Android may ask you to allow installation from your browser.

## Send a file

1. On the sending device, open the app and choose a file.
2. Use the supported 32 x 32 matrix on both devices.
3. Press **Send**. The color frame will keep cycling until you stop it.
4. On the receiving device, open the same app, choose **Receive**, and press **Start camera**.
5. Point the camera at the sender's screen and keep the full frame in view. When enough packets have been decoded, the reconstructed file downloads automatically.

The sender includes the original blocks plus repair packets, then repeats the sequence. That gives the receiver another chance to collect missing data if a frame is blurred or missed. A steady, bright screen, a focused camera, and low glare help. Keep the whole frame visible and use the camera zoom slider to magnify the preview and scan area; higher digital zoom may soften the image. Camera permission requires HTTPS (or localhost), and some mobile browsers restrict camera access when the page is opened from an insecure LAN address.

The receiver samples each module at 25 points near its center and calibrates against the on-frame color palette. CRC32-guided recovery retries packets with ambiguous color readings. Each valid packet is also stored locally in IndexedDB by transfer session and frame ID; collected packets can arrive in any order and are restored when scanning resumes. Saved packets are cleared after SHA-256 verification.

Before packetization, the sender gzip-compresses a file when the compressed result is smaller. Compact metadata stores the SHA-256 digest as 32 binary bytes instead of 64 hexadecimal characters, reducing first-packet overhead and freeing more of each fixed-size frame for file data. The receiver still accepts earlier metadata formats, decompresses within the declared size limit, and verifies the original file's SHA-256 before download. Incompressible files are sent unchanged. Use the current app on both devices for transfers using compact metadata. Visual padding modules are not file data: they balance the palette and stay in place to support reliable color recognition.

The visual layout uses a centered, one-module alternating-ring bullseye: 8 x 8 modules for the even 32 x 32 matrix and 9 x 9 for the odd 63 x 63 matrix. The bullseye and alignment tracks determine orientation. A bright orange locator frame in the quiet zone provides an easy-to-detect boundary; the receiver also falls back to the dark matrix perimeter when the orange marker is obscured or absent.

Every frame spreads the eight palette colors across its data modules, excluding the bullseye and structural guides. The sender applies a reversible packet-seeded color mask after the fixed header and balances unused padding modules; packet bytes, CRC, and capacity are unchanged. The receiver accepts both the current seeded mapping and earlier frames that used the fixed color mask.

## Diagnose and test the receiver

The Receive panel reports camera frames, candidate regions, geometry/orientation, sampled colors, header/CRC results, accepted packets, recovered blocks, and final SHA-256 verification. Its preview overlays candidate corners and the estimated grid; the latest decoder error is shown separately.

Use **Run decoder self-test** to generate and render a real packet, then pass its pixels through the production decoder worker and reconstruction path without a second device. To test a camera photo or screenshot, choose **Decode saved frame** and ensure the selected matrix size matches the image. Neither synthetic test proves camera-to-camera transfer; that still requires testing with two devices.

## Build

```sh
npm run build
npm run preview
```

The root `index.html` is the app's single source entry point. The production build creates `dist/index.html` from it; `dist/` is generated output and is not committed. Production files are written to `dist/`.