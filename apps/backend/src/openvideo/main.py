import uvicorn

BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = 38471


if __name__ == "__main__":
    uvicorn.run(
        "openvideo.ui.api:app",
        host=BACKEND_HOST,
        port=BACKEND_PORT,
        reload=False,
    )
