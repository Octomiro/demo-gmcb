import cv2
import numpy as np
import time

print("=== CAMERA DIAGNOSTIC ===\n")

# Test 1: Open with V4L2, no forced format
cap = cv2.VideoCapture(0, cv2.CAP_V4L2)
# V4L2 order: FOURCC → WIDTH → HEIGHT → FPS (FPS must come after format)
cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
cap.set(cv2.CAP_PROP_FPS, 30)   # last
cap.set(cv2.CAP_PROP_BUFFERSIZE, 2)  # 2 = double-buffer; 1 starves USB DMA

fourcc = int(cap.get(cv2.CAP_PROP_FOURCC))
actual_fmt = "".join([chr((fourcc >> 8*i) & 0xFF) for i in range(4)])
actual_fps = cap.get(cv2.CAP_PROP_FPS)
actual_w   = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
actual_h   = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

print(f"Requested : MJPG 1280×720 @ 30fps")
print(f"Got       : {actual_fmt} {actual_w}×{actual_h} @ {actual_fps:.0f}fps")
print()

# Flush kernel buffer
for _ in range(10):
    cap.grab()

# Test 2: Measure frame delivery timing over 5 seconds
print("Measuring frame delivery (5 seconds)...")
intervals = []
freeze_count = 0
t_prev = time.monotonic()

for i in range(150):
    ret, frame = cap.read()
    t_now = time.monotonic()
    interval_ms = (t_now - t_prev) * 1000
    intervals.append(interval_ms)
    
    if interval_ms > 100:  # >100ms between frames = freeze
        freeze_count += 1
        print(f"  !! FREEZE at frame {i}: {interval_ms:.0f}ms gap")
    
    t_prev = t_now

cap.release()

avg   = np.mean(intervals)
med   = np.median(intervals)
worst = max(intervals)
expected = 1000/30

print(f"\n--- Results ---")
print(f"Expected interval : {expected:.1f}ms (30fps)")
print(f"Average interval  : {avg:.1f}ms  → effective {1000/avg:.1f}fps")
print(f"Median interval   : {med:.1f}ms")
print(f"Worst gap         : {worst:.0f}ms")
print(f"Freeze events (>100ms gap): {freeze_count}")
print()

if freeze_count > 0:
    print("DIAGNOSIS: Frame delivery is irregular — V4L2 buffer/USB issue confirmed")
elif avg > expected * 1.3:
    print("DIAGNOSIS: Camera running slower than requested FPS")
else:
    print("DIAGNOSIS: Frame delivery looks regular at this level")

# Test 3: Check USB errors
print("\n--- USB/UVC kernel messages ---")
import subprocess
result = subprocess.run(
    ["dmesg"], capture_output=True, text=True
)
lines = [l for l in result.stdout.splitlines() 
         if any(k in l.lower() for k in ["usb", "uvc", "video", "xhci"])]
for l in lines[-20:]:
    print(l)