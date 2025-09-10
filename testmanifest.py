import os
import hashlib
import json

# Carpeta donde está tu GTA
GTA_FOLDER = "/var/www/html/downloads"
# Archivo manifest de salida
MANIFEST_FILE = "manifest.json"

def file_hash(path):
    """Calcula SHA256 de un archivo."""
    sha256 = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(4096), b""):
            sha256.update(chunk)
    return sha256.hexdigest()

manifest = {"files": []}

for root, _, files in os.walk(GTA_FOLDER):
    for file in files:
        path = os.path.join(root, file)
        rel_path = os.path.relpath(path, GTA_FOLDER)  # Ruta relativa para el manifest
        size = os.path.getsize(path)
        hash_value = file_hash(path)
        
        manifest["files"].append({
            "path": rel_path.replace("\\", "/"),
            "hash": hash_value,
            "size": size
        })

with open(MANIFEST_FILE, "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=4)

print(f"Manifest generado con {len(manifest['files'])} archivos.")
