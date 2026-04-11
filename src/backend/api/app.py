"""FastAPI application entry point for CerebraLink."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.backend.api.routes import router

app = FastAPI(
    title="CerebraLink",
    description="AI-powered medical assistant with multi-agent council",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3100", "http://127.0.0.1:3100", "http://localhost:3000",
        "https://*.trycloudflare.com",  # Cloudflare quick tunnels
    ],
    allow_origin_regex=r"https://.*\.trycloudflare\.com",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "cerebralink"}
