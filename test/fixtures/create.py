"""Regenerate our tiny attachment fixtures (requires reportlab)."""
from pathlib import Path
import struct
import zlib
from reportlab.pdfgen import canvas

directory = Path(__file__).parent
pdf = canvas.Canvas(str(directory / "marker.pdf"), pagesize=(300, 150), invariant=True)
pdf.drawString(30, 75, "The secret marker is LEMON-IBIS.")
pdf.save()

def chunk(name, data):
    return struct.pack(">I", len(data)) + name + data + struct.pack(">I", zlib.crc32(name + data))

pixels = (b"\x00" + b"\xff\x00\x00" * 64) * 64
png = b"\x89PNG\r\n\x1a\n"
png += chunk(b"IHDR", struct.pack(">IIBBBBB", 64, 64, 8, 2, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")
(directory / "red.png").write_bytes(png)
