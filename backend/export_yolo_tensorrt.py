import argparse
import time
import torch
from ultralytics import YOLO

def main():
    parser = argparse.ArgumentParser(description="YOLO to TensorRT Export Utility")
    
    # Arguments
    parser.add_argument("model", type=str, help="Path to the .pt model file")
    parser.add_argument("--task", type=str, default="detect", choices=["detect", "segment"], 
                        help="Model task: 'detect' or 'segment' (default: detect)")
    parser.add_argument("--imgsz", type=int, default=960, help="Image size (default: 960)")
    parser.add_argument("--half", action="store_true", help="Use FP16 half precision")
    parser.add_argument("--dynamic", action="store_true", help="Enable dynamic input shapes")
    parser.add_argument("--device", type=int, default=0, help="GPU device ID (default: 0)")

    args = parser.parse_args()

    print(f"Initializing export for: {args.model}")
    print(f"Config: task={args.task}, imgsz={args.imgsz}, half={args.half}, dynamic={args.dynamic}, device={args.device}")
    
    start_time = time.time()

    try:
        model = YOLO(args.model)

        engine_path = model.export(
            format="engine",
            imgsz=args.imgsz,
            half=args.half,
            dynamic=args.dynamic,
            device=args.device,
            simplify=True
        )

        elapsed = time.time() - start_time
        print(f"\n SUCCESS: Engine exported in {elapsed:.1f}s")
        print(f" Location: {engine_path}")

        print("\n Starting Production Warmup...")
        trt_model = YOLO(engine_path, task=args.task)
        
        # dummy warmup
        dummy_frame = torch.zeros((1, 3, args.imgsz, args.imgsz)).to(f"cuda:{args.device}")
        if args.half:
            dummy_frame = dummy_frame.half()
            
        # Run inference once to initialize CUDA context and engine memory
        _ = trt_model(dummy_frame, verbose=False)
        print("Warmup complete. Engine is verified.")

    except Exception as e:
        print(f"\n EXPORT FAILED: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main()