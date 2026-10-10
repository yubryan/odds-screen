"""Launch the app: python run.py [--port 8000] [--no-browser]"""
import argparse
import threading
import webbrowser

import uvicorn

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    if not args.no_browser:
        threading.Timer(1.0, webbrowser.open, [f"http://127.0.0.1:{args.port}"]).start()
    uvicorn.run("oddscreen.app:app", host="127.0.0.1", port=args.port)
