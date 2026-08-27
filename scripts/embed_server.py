#!/usr/bin/env python3
"""
Embedding HTTP server for dsh-memory-connect.
Serves BGE-small-zh-v1.5 embeddings via a tiny stdlib HTTP endpoint so the
Node plugin can do semantic recall without loading heavy JS ML stacks.

Endpoints:
  GET  /health          -> {"ok": true, "model": "...", "dim": 384}
  POST /embed           -> {"embeddings": [[0.1, ...], ...]}  (JSON body: {"texts": ["..."]})
  POST /embed_batch     -> same as /embed (alias)

Usage:
  python3 embed_server.py [--host 127.0.0.1] [--port 8765] [--model BAAI/bge-small-zh-v1.5]

The model is loaded lazily on first /embed call and kept resident.
"""
import argparse
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = None
MODEL_NAME = None
LOAD_LOCK = threading.Lock()
FAILED = False
FAIL_REASON = ""


def load_model(name):
    global MODEL, MODEL_NAME, FAILED, FAIL_REASON
    with LOAD_LOCK:
        if MODEL is not None:
            return True, ""
        if FAILED:
            return False, FAIL_REASON
        try:
            from sentence_transformers import SentenceTransformer
            MODEL = SentenceTransformer(name)
            MODEL_NAME = name
            return True, ""
        except Exception as exc:  # noqa: BLE001
            FAILED = True
            FAIL_REASON = f"{type(exc).__name__}: {exc}"
            return False, FAIL_REASON


def embed_texts(texts):
    """Return list of normalized embedding vectors (Python lists of floats)."""
    if MODEL is None:
        ok, err = load_model(MODEL_NAME or "BAAI/bge-small-zh-v1.5")
        if not ok:
            raise RuntimeError(err)
    vecs = MODEL.encode(list(texts), normalize_embeddings=True)
    return [v.tolist() for v in vecs]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # silence noisy logging
        pass

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health" or self.path.startswith("/health"):
            dim = 0
            if MODEL is not None:
                try:
                    dim = MODEL.get_sentence_embedding_dimension()
                except Exception:  # noqa: BLE001
                    dim = 0
            self._send(200, {"ok": True, "model": MODEL_NAME, "dim": dim})
            return
        self._send(404, {"error": "not found"})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 10_000_000:
                self._send(413, {"error": "payload too large"})
                return
            raw = self.rfile.read(length) if length else b"{}"
            payload = json.loads(raw.decode("utf-8"))
            texts = payload.get("texts") or payload.get("text") or []
            if not isinstance(texts, list) or not texts:
                self._send(400, {"error": "texts required"})
                return
            if any(not isinstance(t, str) for t in texts):
                self._send(400, {"error": "texts must be strings"})
                return
            try:
                embeddings = embed_texts(texts)
            except RuntimeError as exc:
                self._send(500, {"error": str(exc)})
                return
            self._send(200, {"embeddings": embeddings, "dim": len(embeddings[0]) if embeddings else 0})
        except (json.JSONDecodeError, ValueError) as exc:
            self._send(400, {"error": f"bad request: {exc}"})
        except Exception as exc:  # noqa: BLE001
            self._send(500, {"error": f"{type(exc).__name__}: {exc}"})


def main():
    ap = argparse.ArgumentParser(description="bge embedding HTTP server")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--model", default="BAAI/bge-small-zh-v1.5")
    args = ap.parse_args()

    global MODEL_NAME
    MODEL_NAME = args.model

    # Preload at startup (so first /embed is fast); failures are non-fatal.
    ok, err = load_model(args.model)
    if ok:
        print(f"[embed-server] model loaded: {MODEL_NAME}", flush=True)
    else:
        print(f"[embed-server] WARNING model failed to load: {err}", flush=True)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[embed-server] listening on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
