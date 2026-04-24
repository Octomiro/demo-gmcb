# GMCB Detection System — Architecture & Pipeline Audit
> **Purpose**: Complete description of how the system works, why it is designed this way, what alternatives were evaluated, and what the real constraints are.

---

## 1. What the System Does (Non-Technical Summary)

The GMCB system monitors a flour production conveyor belt using two cameras connected to a server. In real time and without any human operator watching:

- **Camera 1 (Barcode & Date)**: Detects every package passing on the belt, reads its barcode and expiry date, and decides: **OK** (barcode present + valid date) or **NOK** (missing or unreadable).
- **Camera 2 (Anomaly)**: Inspects the visual surface of each package to detect **physical defects** (tears, wrong fill, contamination) using AI trained on what a normal package looks like we opted for EfficientAd(Fastest after benchmarking with sk-rd4ad and rd4ad even though sk-rdad is more accurate).

Every decision is recorded in a database with a snapshot image. Operators view results live on a web dashboard from any computer on LAN (strictly asked by gmcb no ssh/vpn/wan).

---

## 2. Hardware Setup

```
┌─────────────────────────────────────────────────────────┐
│                        SERVER                           │
│  CPU: ryzon 9 gmcb-i9 14g 9arnita                       │
│  GPU: NVIDIA (CUDA 12.6 9arnita/13.1    gmcb )                            
│  RAM: 32 GB                                             │
│  USB: Bus 001 (480 Mbps, USB 2.0 controller)            │
│        Bus 002 (20 Gbps, USB 3.2 controller)     │
└───────────────┬───────────────────┬─────────────────────┘
                │                   │
     USB 2.0 Active Extender  USB 2.0 Active Extender
     (~15m cable)           (~2*10m cable )
                │                   │
        ┌───────┴──────┐    ┌───────┴──────┐
        │  Camera 1    │    │  Camera 2    │
        │  /dev/video0 │    │  /dev/video2 │
        │  Global      │    │  Global      │
        │  Shutter     │    │  Shutter     │
        │  USB 2.0     │    │  USB 2.0     │
        │              │    │              │
        └──────────────┘    └──────────────┘
```

Important: Both cameras are USB 2.0 devices.
Both are assigned to Bus 001 (shared 480 Mbps).
Bus 002 (20 Gbps) cannot be used by these cameras — USB 2.0 devices are routed to the USB 2.0 controller regardless of the physical port they are plugged into. This was tested and confirmed using a RealSense camera (USB 3.0), which was automatically connected to Bus 002. A possible alternative to ensure both cameras (even USB 2.0) are connected to different buses and to fully avoid bandwidth risks would be to use a PCIe USB expansion card.

** After the last visit to GMCB, we switched from YUYV (raw format) to MJPEG (compressed JPEG frames), which drastically reduced USB bandwidth.

Bandwidth formula:
Bandwidth = width × height × 2 × FPS

Previously, we were using 1080p at 60 FPS, so the bandwidth was already heavily saturated even with a single camera:

1920 × 1080 × 2 × 60 = 990 Mbps

This is more than twice the theoretical USB 2.0 limit (480 Mbps). In practice, to keep the system stable, we should not exceed ~300–350max Mbps.

Even after reducing to 30 FPS, it was still too heavy. The same issue applied to 720p(no compression).

With MJPEG, compression happens inside the camera hardware itself, which makes it the best solution. The issue was resolved by switching to MJPEG (two possible approaches: system-level or code-level configuration). We chose the code-level approach since the driver already supports MJPEG: (reader.py we pass the parameter)

cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))

bizarrement on Soubya we were not experiencing YUYV bandwidth issues. The reader was working normally, possibly because we were using Ubuntu 24 Desktop, which already has better USB/video driver integration compared to 9arnita/GMCB.

I also tried splitting pipelines:

anomaly pipeline → 720p
barcode/date pipeline → 1080p

The idea was that the date recognition would benefit from higher resolution since it is not always clearly visible to the human eye (theoretical and not fully validated on the real conveyor.)

In practice, I faced bandwidth issues, and they are expected to become worse in real production conditions. MJPEG is also content-dependent: when frame complexity increases (movement, textures, reflections), compression efficiency decreases, increasing effective bandwidth usage.

For this reason, we reverted to the initial design choice: keeping 720p for both pipelines, which ensures stable bandwidth usage even in real-world conditions.

To measure system-level USB bandwidth in real time, we can use:

sudo usbtop

This provides live monitoring of USB throughput. However, it is not currently installed on 9arnita, so we rely on code-level estimations inside the reader.

Regarding cables: one cable was rejected after several hours of testing, as it appeared unstable noticable delay in comparaisson to the other cables. For now, the remaining cables are validated.(2*10 m +15 m)

An alternative is fiber optic USB extension (more expensive we found one worth 120 euros on amazon that supports both 3.2 and 2.0). However, it requires a power supply (theoretically), and while it is excellent for long-distance data transmission, 20-meter setups may still introduce occasional micro-power drops or instability depending on the environment.
For now cable decision is final
---

## 3. Full Pipeline — Step by Step

Each camera runs a completely **independent, parallel pipeline**. They never block each other at the software level.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     PIPELINE (per camera)                               │
│                                                                         │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐            │
│  │   THREAD 1   │     │   THREAD 2   │     │   THREAD 3   │            │
│  │   READER     │────▶│   DETECTOR   │     │  COMPOSITOR  │            │
│  │              │     │              │     │              │            │
│  │ V4L2 driver  │     │ YOLO inference│    │ Draw overlays│            │
│  │ 30 fps       │     │ ByteTrack    │     │ Resize frame │            │
│  │ Raw BGR frame│     │ + EfficientAD│     │ JPEG encode  │            │
│  │ CPU RAM      │     │ on GPU       │     │ Store bytes  │            │
│  └──────┬───────┘     └──────┬───────┘     └──────┬───────┘            │
│         │                   │                     │                    │
│    _raw_frame           _overlay dict         _jpeg_bytes              │
│    (single slot)        (latest only)         (pre-encoded)            │
│         │                   │                     │                    │
│         └──────────────────▶└────────────────────▶│                    │
│                                                    │                    │
│                                             Flask /video_feed           │
│                                             yields bytes instantly      │
└─────────────────────────────────────────────────────────────────────────┘
                                                    │
                                             nginx (no buffer)
                                                    │
                                         ┌──────────┴──────────┐
                                         │  Browser (LAN)       
                                         │  <img> MJPEG over HTTP  
                                         └─────────────────────┘
```

### Data flow in plain language

1. The **Reader** thread calls `cap.read()` on the camera 30 times per second. Each call returns one uncompressed BGR image in CPU RAM. It never waits for detection — it always serves the latest frame.
2. Every frame (or every Nth frame if `FRAME_SKIP > 1`) is handed to the **Detector** thread via a single-slot variable. The detector runs YOLO on the GPU, gets bounding boxes, then runs EfficientAD for anomaly scoring. Results are stored as an overlay dictionary.
3. The **Compositor** thread wakes on every new reader frame, draws the latest overlay boxes on the raw frame, resizes it to stream resolution, and JPEG-encodes it using TurboJPEG (libjpeg-turbo, SIMD-accelerated, GIL-free). The result is stored as pre-encoded bytes.
4. The **Flask streaming endpoint** (`/video_feed`) checks if new bytes are available and yields them immediately to the browser. Zero re-encoding in the HTTP layer.
5. **Nginx** proxies the stream with `proxy_buffering off` — no additional buffer.
6. The **browser** receives a standard MJPEG stream and renders it natively using its built-in hardware-accelerated decoder.

---

## 4. Pipeline 1 — Barcode & Date Tracking

| Parameter | Value |
|-----------|-------|
| Camera | `/dev/video0` —  720p |
| YOLO model | `yolo26m_BB_barcode_date.pt` |
| Detection targets | `package`, `barcode`, `date` |
| Inference resolution | 640px |
| Tracker | ByteTrack |
| Secondary date model | `yolo26-BB(date).pt` (runs in parallel thread) |
| Exit line | Vertical, at 85% of frame width |
| Stream resolution | 1280×720  

()

### Decision logic

```
Package enters frame (right side)
    ↓
ByteTrack assigns persistent ID → tracked across frames
    ↓
As package moves left, barcode and date detections are
associated by IoU 
    ↓
Package reaches EXIT LINE (85% of frame width)
    ↓
    ├── barcode detected + date detected → OK
    ├── barcode detected, no date       → NOK
    ├── no barcode detected             → NOK
    ↓
Result written to PostgreSQL database for stats+ image saved to local disk (no s3) + ejection logic still not clear the plc team asked us to install node red (a lowcode program so they can command the ejector)
```

The secondary date model runs **in parallel** on a ThreadPoolExecutor (1 worker). Its date detections are merged with the primary model's results as in the registred videos with this secondary model the precision got higher less false positives and faster recognisation only trained on date( from a rotated angle but we inversed the images for training)

---

## 5. Pipeline 2 — Anomaly Detection

| Parameter | Value |
|-----------|-------|
| Camera | `/dev/video2` — 1280×720 capture |
| YOLO model | `yolo26m_seg_farine_FV_v3.pt` (segmentation) |
| Detection target | `farine` (flour package) |
| Inference resolution | 960px | (we have a lighter model v1 640 and another one v2 1280 we will test and see once there an keep the best one accuracy/inferencetime as for vram we don't have a problem )
| Anomaly model | EfficientAD (teacher/student/autoencoder) |
| Anomaly inference size | 256×256 px |
| Decision strategy | MAJORITY vote across up to 7 scans per package |
| Anomaly threshold | 5000.0 |
| Stream resolution | 1280×720|

### Decision logic

```
Package enters scan zone 
    ↓
YOLO segmentation extracts precise object mask
    ↓
Object is cropped + background blacked out + letterboxed to 256×256
    ↓
EfficientAD teacher/student/autoencoder inference on GPU
    → produces anomaly score (higher = more abnormal)
    ↓
Score compared to threshold (5000.0)
    ↓
Result stored per-scan. Up to 7 scans collected per package.
    ↓
Package reaches EXIT LINE (zone_start_pct = 20% from left)
    ↓
MAJORITY vote: if >50% of scans are anomalous → NOK
                otherwise → OK
    ↓
Result written to PostgreSQL database+image as proof of ejection
```

The **1280×720 capture resolution** for this camera is intentional:  
EfficientAD internally resizes every crop to 256×256 regardless of input size.  
Higher capture resolution provides zero benefit to anomaly accuracy here,  
but would increase USB bandwidth usage significantly and efficietad  works on feature anomalies, not raw detail.

---

## 6. Live Dashboard Streaming

### Transport: MJPEG over HTTP

Each pipeline streams independently via `/video_feed?pipeline=<id>`.

```
Compositor pre-encodes frame → _jpeg_bytes (CPU RAM)
    ↓
Flask generator checks _jpeg_event (gevent-friendly poll, 3ms interval)
    → yields frame immediately when available (no sleep-then-check delay)
    ↓
HTTP chunked transfer: --frame\r\nContent-Type: image/jpeg\r\n...
    ↓
nginx: proxy_buffering off, proxy_cache off, chunked_transfer_encoding off
    ↓
Browser: native MJPEG decoder (hardware-accelerated, zero JS overhead)
```

### JPEG encoding

| Encoder | Used | Why |
|---------|------|-----|
| TurboJPEG (libjpeg-turbo SIMD) | ✅ Yes (primary) | Releases Python GIL → true parallel encode. ~5-10ms at 720p quality 60 |
| cv2.imencode (OpenCV) | Fallback only | Holds GIL partially. Used only if TurboJPEG is unavailable |
| NVJPEG (GPU JPEG) | ❌ No | Frames live in CPU RAM. CPU→GPU→CPU round-trip (~5ms) is slower than TurboJPEG itself (~5-10ms). Net loss. |

### Stream parameters (current defaults)

| Parameter | Value | Effect |
|-----------|-------|--------|
| `JPEG_QUALITY` | 60 | Dashboard display only. Detection not affected (it was before 80 but tested smoother + acceptable quality with new value). |
| `STREAM_WIDTH` | 1280 | Dashboard display only. Detection runs at full capture resolution. |
| `STREAM_HEIGHT` | 720 | Same as above. |
| Default FPS | 30 | Matches camera FPS to ensre no artificial throttling. |

---

## 7. Threading Model — Why Three Threads Per Pipeline

The three-thread design is central to the system's smoothness.

### The problem with a naive single-thread design (tested on the videos enregistre and it was workign in slow motion)

```
read frame → run YOLO (30-80ms) → encode JPEG → stream
Stream FPS = 1 / (33ms + 70ms + 10ms) = ~8 fps  ← laggy (unlike the real camera that is capturing at60/30 so on dashboard they will not be convinced taht we can achieve real time detecion the video streamed big big difference from what they see with their eyes)
```

### The three-thread design used

```
Thread 1 READER:     read → store latest frame          (30 fps, never blocked important later for the ejection logic)
Thread 2 DETECTOR:   YOLO → overlay dict                (12-20 fps, GPU-paced)
Thread 3 COMPOSITOR: draw overlay + encode JPEG         (30 fps, display-paced)
```

- **Reader never waits for YOLO.** Stream is always smooth at 30 fps even when GPU is busy.
- **Compositor draws the latest overlay on the latest frame.** Boxes may be 1 frame behind on fast motion — acceptable for a display.
- **No queue between threads.** Single-slot variables (`_raw_frame`, `_overlay`, `_jpeg_bytes`) mean the system always processes the **most recent** data, never a backlog.

### gevent + threading

The Flask server uses **gevent** (cooperative green threads) for HTTP handling.  
The three pipeline threads are **real OS threads**  because:
- Camera I/O (`cap.read()`) blocks the OS, cannot yield cooperatively
- GPU inference holds C++ code that bypasses Python entirely

`monkey.patch_all(thread=False)` is used to prevent gevent from replacing `threading.Event.wait()`, which would block the gevent hub. Instead, the MJPEG generator uses a `gevent.sleep(0.003)` polling loop, yielding control to other HTTP clients while waiting for a new frame.

---

## 8. Key Configuration Values

All in `backend/tracking_config.py`:

| Variable | Value | What it controls |
|----------|-------|-----------------|
| `CAMERA_WIDTH` | 1280 | Capture resolution width (barcode pipeline) |
| `CAMERA_HEIGHT` | 720 | Capture resolution height (barcode pipeline) |
| `STREAM_WIDTH` | 1280 | Dashboard stream width (both pipelines) |
| `STREAM_HEIGHT` | 720 | Dashboard stream height (both pipelines) |
| `JPEG_QUALITY` | 60 | JPEG compression for dashboard stream only |
| `CAMERA_FPS` | 30 | Target FPS requested from camera driver |
| `DETECTOR_FRAME_SKIP` | 1 | Run YOLO on every frame (read description on anomly frame skip same logic but we where only skipping 2)  |
| `ANOMALY_FRAME_SKIP` | 1 | Run anomaly detection on every frame we tested skipping 3 frames sometimes we don't have enough time to scan the flour packet in the zone (it was benefecial while having 60 fps but now with 30fps could be removed)(revertng back to 60fps and dropping frames will have same result in detecion but double the bandwidth problem on usb)|
| `DEVICE` | `cuda` | (Parameterable) to ensure GPU inference for all models no cpu|


## 9. Evaluated Alternatives — Why They Were Not Adopted

### 9.1 GStreamer for camera capture

**What it is**: A multimedia pipeline framework that can chain capture → processing → encode in a single graph, potentially keeping data on GPU (zero-copy).

**Why it does NOT help here**:

> USB UVC cameras (V4L2 driver) always write frames to **CPU RAM** — that is the USB driver's job by definition. Even with `gst-launch v4l2src`, the frames land in CPU memory. There is no zero-copy path from a USB camera to GPU on standard x86 hardware.

The only scenario where GStreamer GPU zero-copy is beneficial is with **RTSP network cameras** equipped with hardware H.264 encoders, where `nvdec` can decode the H.264 stream directly on GPU. That is not the case here. (confirmed from discussions on groups)

Additional concerns:
- GStreamer adds significant deployment complexity (native libraries, pipeline configuration)
- The current OpenCV `cap.read()` path with V4L2 is already the most direct path available
(we tested this on 10 minutes video running the 2 live cameras and the frames returned where close to what was expected which is 10*60*30 so for now validated)
 **choix 1** using OpenCV built with gstreamer backend better for higher fps/resolution or rtsp camera but for 720p and 30fps +usb camera( it performed a little bit worse so the default v4l2 was kept)
(For RTSP camera if we decided to change there is in code CAP_FFMPEG we  use the one with gstreamer backend low probability to switch as at gmcb manufactor they have network issues)
 **choix 2** using Opencv with ffmpeg backend (at first itfailed to open the camera because of version then performed way worse (could be a built/compatibility problem )) 
 
final decision:
Camera → USB → CPU RAM → [V4L2 / GStreamer / FFmpeg] → your numpy array
                                    ↑
                            this part doesn't matter
                            as long as it works and costs nothing extra as direct gpu not possible


**gstreamer/ffmpeg direct** No Gain Over What i Have (CAP_V4L2 already delivers perfect 30fps —> the hardware ceiling
+adds startup delay+may break between versions while the v4l2 stable since 2002 + Ecosystem Integration as all the current pipeline is expecting opencv output)

---
we move to discuss what was tested for streaming 

### 9.2 WebSocket for video streaming (instad of mjpeg over http)

**What it is**: A persistent bidirectional TCP connection over which binary frames could be sent. The frontend would receive frames as binary blobs and draw them on an HTML5 `<canvas>`.

**Why MJPEG is better for LAN video**:

On a **local area network**, bandwidth is not constrained. There is no benefit to switching transport. MJPEG wins because the browser's native decoder is faster than any JavaScript alternative.

**Where WebSocket does make sense**: pushing **stats and counters** to the dashboard in real time, replacing the current 1.5-second polling interval. This is a planned improvement for the stats panel only (not video).

**Verdict**: No benefit for video on LAN. Adds complexity and increases browser CPU usage.
(tested and confirmed at the octomiro office the tablette was showing a recorded vidoe of the conveyor line it was smoother with mjpeg over http )
---

### 9.3 H.264 / NVENC GPU encoding

**What it is**: H.264 is a video compression codec that encodes sequences of frames using inter-frame prediction (each frame references the previous). NVENC is NVIDIA's hardware H.264 encoder on the GPU.

**Why it does NOT help here**:

> H.264 latency is structurally incompatible with real-time industrial monitoring.

H.264 requires a **Group of Pictures (GOP)** — typically 30-60 frames — before a decoder can render anything. This introduces 1-2 seconds of inherent buffering latency. Industrial defect detection requires latency under 200ms to be useful.

Additionally:
- NVENC still requires frames in CPU RAM as input (same pipeline as current)
- At 720p MJPEG quality 60, each frame is ~50-80KB. On a 1 Gbps LAN, this is 0.05% of available bandwidth — not a constraint
- H.264 would benefit a **WAN / remote monitoring scenario** where bandwidth is limited, not a factory LAN

| | MJPEG (current) | H.264 NVENC |
|--|--|--|
| Latency | 80-150ms | 1000-2000ms |
| LAN bandwidth | ~25 Mbps (2 streams) | ~2-5 Mbps |
| GPU cost | 0 (encode is CPU) | ~5% GPU | 
| Frontend complexity | Zero (native `<img>`) | HLS player or WebRTC stack |
| Benefit on LAN | Full | None (bandwidth not constrained) |

**Verdict**: Increases latency 10×. Not suitable for real-time industrial monitoring on LAN.

---

### 9.4 nvJPEG (GPU JPEG encoding)

**What it is**: NVIDIA's CUDA-accelerated JPEG encoder, part of the nvJPEG library.

**Why TurboJPEG is faster in this context**:

Frames live in CPU RAM (from USB camera via V4L2). Using nvJPEG requires:
1. Allocate GPU buffer
2. Copy frame CPU → GPU via PCIe (~0.2ms)
3. nvJPEG encode on GPU (~2-3ms)
4. Copy result GPU → CPU via PCIe (~0.1ms)

TurboJPEG (libjpeg-turbo with SIMD):
1. Encode in-place in CPU RAM (~5-10ms, no transfers)
2. Releases the Python GIL → true parallelism with other threads

Total time: TurboJPEG **~5-10ms** vs nvJPEG **~5-10ms + 0.3ms transfer overhead**.  
They are equivalent in speed, but TurboJPEG **releases the GIL** (critical for parallel threads) and requires zero GPU memory or CUDA synchronization.

**Verdict**: Already using the optimal encoder. nvJPEG offers no advantage for CPU-resident frames.

---

## 10. Known Constraints & Hardware Bottleneck

### USB bandwidth (primary constraint)

Both cameras share **Bus 001 (480 Mbps)** because both active extender cables are USB 2.0. Even though both cameras are USB 3.0 capable, the cable limits negotiation speed.

In typical operation this is safe. At extreme scene complexity (both cameras simultaneously view very high-texture scenes), the bus can approach saturation → FPS drops.

**Permanent fix**: Replace both cameras with **USB 3.0 models** (same form factor, global shutter preferred).  
- With USB 3.0 cameras + USB 3.0 extenders, each camera can be placed on a separate controller (Bus 001 + Bus 002)  
- Zero shared bandwidth  
- Full 1920×1080 on both cameras possible without contention  

---

## 11. Risk: FPS Drop → Detection Gap

When USB bandwidth is saturated:

```
V4L2 driver drops frames at kernel level
    ↓
reader_fps drops from 30 to 15 or lower
    ↓
Detector processes fewer frames per second
    ↓
Fast-moving package can pass through detection zone
between two consecutive frames
    ↓
Missed detection → false OK
```

To adress that i added a notification on the dashboard   when `reader_fps < 22`. This is a **visual warning only** — it does not affect decisions or flag packages.

**Recommended improvement** (not  implemented): When FPS drops below threshold during a package's scan window, automatically mark that package as `UNCERTAIN` instead of `OK`, forcing manual inspection. This converts a potential silent false OK into a conservative false positive  (to discuss as as most packets are okay i don't see why we eject them if we are doubting)

---

## 12. What Can Still Be Improved (cote frontend)

 WebSocket push for dashboard stats | Low — counters update instantly vs 1.5s lag i'm pulling now
 Webrtc instead of mjpeg over http

---

## 13. Why the Full Pipeline Cannot Run Entirely on GPU

A natural question is: *"Since the GPU outperforms the CPU for compute, why not run everything on the GPU?"*

The answer is that **frames from USB cameras always land in CPU RAM** — this is physically unavoidable — so a fully GPU-resident pipeline does not exist on this hardware.

### Stage 1 — Camera capture (Reader thread)

The USB/UVC driver writes every frame directly into **CPU RAM** via the V4L2 kernel interface. This is what USB means at the hardware level — there is no DMA path from a USB camera to GPU memory on x86. Even GStreamer with `v4l2src` cannot change this . The frame is in CPU RAM from the first microsecond it exists.

### Stage 2 — YOLO + EfficientAD (Detector thread)

This **already runs on GPU** (`DEVICE = cuda`). YOLO and EfficientAD inference are fully GPU-accelerated. The CPU→GPU copy here is unavoidable (frame originates from USB) but is a one-time upload during inference — worth it for the heavy compute savings.

### Stage 3 — Compositor (overlay drawing + JPEG encode)

- Drawing bounding boxes with OpenCV takes ~1ms on CPU (SIMD-accelerated). Copying the frame to the GPU to draw boxes, then copying the result back, would cost an additional ~0.3–0.5ms in PCIe transfers — a net loss.
- TurboJPEG encodes in-place in CPU RAM in ~5–10ms **and releases the Python GIL**, enabling true parallelism with the other threads. nvJPEG would take equivalent time plus PCIe round-trip overhead 


**With NVIDIA jetson there is a youtube video showing how to write on gpu directly with a usb camera +explication of other alternatives(https://www.youtube.com/watch?v=rs4mQcJAjMM)

**WEBRTC (could be next step after testing at gmcb with their network according to thameur a better option but i rememeber when searching that it have problems with reconnection ) 

**vram liberation between sessions + cpu memory leek+ gpu memory leek (i tested with opeing mord than a session and verifying in the stats the vram was back to how it was at first +for cpu/gpu i used copilot to do an audit of the full code and it returned with errors to rectify and i did so but need double verification )

**if we restart the server the containers reopen but the ports could be distrubute differently so the camera/pipelines are inversed i made an interface in the dashbord called parameter where admins cna switch from there without touching the hardware but there is a system level config to avoid randomly allocating ports 

