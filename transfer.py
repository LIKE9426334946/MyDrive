#!/usr/bin/env python3
"""Upload one or more Kaggle files to the MyDrive /kaggle directory."""

from __future__ import annotations

import mimetypes
import os
import re
import sys
import uuid
from pathlib import Path
from urllib.parse import quote

import requests


SERVER_URL = "http://62.234.33.110:16025/api/upload"
TOKEN = "PASTE_YOUR_KAGGLE_UPLOAD_TOKEN_HERE"
TARGET_PATH = "kaggle"
CHUNK_SIZE = 8 * 1024 * 1024
READ_TIMEOUT_SECONDS = 24 * 60 * 60


def human_size(size: int) -> str:
    units = ("B", "KB", "MB", "GB", "TB")
    value = float(size)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{size} B"


def ascii_filename(filename: str) -> str:
    fallback = filename.encode("ascii", "replace").decode("ascii")
    fallback = re.sub(r'["\\\r\n]', "_", fallback)
    return fallback or "upload.bin"


class MultipartUpload:
    """A re-iterable-size multipart body that never loads the file into memory."""

    def __init__(self, file_path: Path) -> None:
        self.file_path = file_path
        self.file_size = file_path.stat().st_size
        self.boundary = f"----MyDrive{uuid.uuid4().hex}"
        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        encoded_name = quote(file_path.name, safe="")
        fallback_name = ascii_filename(file_path.name)

        self.prefix = (
            f"--{self.boundary}\r\n"
            'Content-Disposition: form-data; name="path"\r\n\r\n'
            f"{TARGET_PATH}\r\n"
            f"--{self.boundary}\r\n"
            'Content-Disposition: form-data; name="file"; '
            f'filename="{fallback_name}"; filename*=UTF-8\'\'{encoded_name}\r\n'
            f"Content-Type: {content_type}\r\n\r\n"
        ).encode("utf-8")
        self.suffix = f"\r\n--{self.boundary}--\r\n".encode("ascii")

    def __len__(self) -> int:
        return len(self.prefix) + self.file_size + len(self.suffix)

    def __iter__(self):
        yield self.prefix
        uploaded = 0
        with self.file_path.open("rb") as file_handle:
            while True:
                chunk = file_handle.read(CHUNK_SIZE)
                if not chunk:
                    break
                uploaded += len(chunk)
                self.show_progress(uploaded)
                yield chunk
        if self.file_size == 0:
            self.show_progress(0)
        yield self.suffix

    def show_progress(self, uploaded: int) -> None:
        percent = 100 if self.file_size == 0 else min(100, uploaded * 100 / self.file_size)
        width = 28
        completed = round(width * percent / 100)
        bar = "=" * completed + "-" * (width - completed)
        print(
            f"\rUploading {self.file_path.name}: [{bar}] {percent:6.2f}% "
            f"{human_size(uploaded)} / {human_size(self.file_size)}",
            end="",
            flush=True,
        )


def upload_file(file_path: Path) -> bool:
    body = MultipartUpload(file_path)
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": f"multipart/form-data; boundary={body.boundary}",
        "Content-Length": str(len(body)),
    }

    try:
        response = requests.post(
            SERVER_URL,
            data=body,
            headers=headers,
            timeout=(30, READ_TIMEOUT_SECONDS),
        )
        print()
    except requests.RequestException as error:
        print()
        print(f"Upload failed: {file_path.name}")
        print(f"Reason: {error}")
        return False

    try:
        result = response.json()
    except ValueError:
        result = {}

    if response.ok and result.get("status") == "success":
        stored_name = result.get("filename", file_path.name)
        if stored_name == file_path.name:
            print(f"Upload success: {file_path.name}")
        else:
            print(f"Upload success: {file_path.name} -> {stored_name}")
        return True

    message = result.get("message") or result.get("error") or f"HTTP {response.status_code}"
    print(f"Upload failed: {file_path.name}")
    print(f"Reason: {message}")
    return False


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python transfer.py FILE [FILE ...]")
        return 2
    if TOKEN == "PASTE_YOUR_KAGGLE_UPLOAD_TOKEN_HERE" or not TOKEN.strip():
        print("Please paste KAGGLE_UPLOAD_TOKEN into the TOKEN variable first.")
        return 2

    success = True
    for raw_path in sys.argv[1:]:
        file_path = Path(os.path.expanduser(raw_path))
        if not file_path.is_file():
            print(f"Upload failed: {file_path.name or raw_path}")
            print("Reason: file does not exist or is not a regular file")
            success = False
            continue
        if not upload_file(file_path):
            success = False
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())
