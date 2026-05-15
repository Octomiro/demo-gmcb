@app.route('/api/cameras/preview', methods=['GET'])
def api_cameras_preview():
    import cv2
    import base64
    
    snapshots = {}
    running_sources = {}
    for pid, st in _all_states():
        if st.is_running:
            running_sources[st.video_source] = st

    for cam in CAMERAS:
        src = cam["source"]
        if src in running_sources:
            # Use active pipeline stream
            st = running_sources[src]
            jpeg_bytes = getattr(st, '_latest_jpeg_low', None) or getattr(st, '_latest_jpeg', None)
            if jpeg_bytes:
                b64 = base64.b64encode(jpeg_bytes).decode('utf-8')
                snapshots[str(src)] = f"data:image/jpeg;base64,{b64}"
        else:
            # Open directly
            cap = cv2.VideoCapture(src)
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            ret = False
            for _ in range(5):
                ret, frame = cap.read()
            if ret and frame is not None:
                frame = cv2.resize(frame, (640, 480))
                ret, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 60])
                if ret:
                    b64 = base64.b64encode(buf.tobytes()).decode('utf-8')
                    snapshots[str(src)] = f"data:image/jpeg;base64,{b64}"
            cap.release()
            
    return jsonify({"snapshots": snapshots, "cameras": CAMERAS, "pipelines": PIPELINES})
