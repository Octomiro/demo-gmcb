import cv2
import time

# Open camera
cap = cv2.VideoCapture(0, cv2.CAP_V4L2)

# Set resolution + FPS
cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
cap.set(cv2.CAP_PROP_FPS, 30)

# Optional: force MJPG
cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))

# Warmup (important)
for _ in range(10):
    cap.read()

# Measure FPS
count = 0
start = time.time()

while count < 100:
    ret, frame = cap.read()
    if not ret:
        print("Frame read failed")
        break
    count += 1

end = time.time()

print("Measured FPS:", count / (end - start))

# Print actual format
fourcc = int(cap.get(cv2.CAP_PROP_FOURCC))
fmt = "".join([chr((fourcc >> 8*i) & 0xFF) for i in range(4)])
print("Format:", fmt)

cap.release()