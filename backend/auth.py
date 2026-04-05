import hashlib
import os
import secrets as _secrets
import uuid as _uuid
from datetime import datetime, timedelta
from pathlib import Path

import jwt as pyjwt
from flask import Blueprint, jsonify, request, send_file
from werkzeug.utils import secure_filename

from pipeline_manager import db_writer

auth_bp = Blueprint("auth", __name__)

_JWT_SECRET = os.environ.get("JWT_SECRET") or _secrets.token_hex(32)
_JWT_ALGORITHM = "HS256"
_JWT_EXPIRY_HOURS = 24

# Screenshots stored here (mapped to ./data/feedback_screenshots on host)
SCREENSHOTS_DIR = Path(os.environ.get("SCREENSHOTS_DIR", "/app/feedback_screenshots"))
SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)

_ALLOWED_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
_MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024  # 8 MB


def _verify_password(stored, provided):
    salt, expected = stored.split(":", 1)
    h = hashlib.sha256((salt + provided).encode()).hexdigest()
    return h == expected


def _hash_password(password):
    salt = _secrets.token_hex(16)
    h = hashlib.sha256((salt + password).encode()).hexdigest()
    return salt + ":" + h


@auth_bp.route('/api/auth/login', methods=['POST'])
def api_auth_login():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""

    user = db_writer.get_auth_user(email) if db_writer else None
    if not user or not _verify_password(user["pw_hash"], password):
        return jsonify({"error": "Email ou mot de passe incorrect"}), 401

    payload = {
        "email": email,
        "role": user["role"],
        "iat": datetime.now().timestamp(),
        "exp": (datetime.now() + timedelta(hours=_JWT_EXPIRY_HOURS)).timestamp(),
    }
    token = pyjwt.encode(payload, _JWT_SECRET, algorithm=_JWT_ALGORITHM)
    return jsonify({"token": token, "email": email, "role": user["role"]})


@auth_bp.route('/api/auth/me', methods=['GET'])
def api_auth_me():
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return jsonify({"error": "missing token"}), 401
    token = auth_header[7:]
    try:
        payload = pyjwt.decode(token, _JWT_SECRET, algorithms=[_JWT_ALGORITHM])
        return jsonify({"email": payload["email"], "role": payload["role"]})
    except pyjwt.ExpiredSignatureError:
        return jsonify({"error": "token expired"}), 401
    except pyjwt.InvalidTokenError:
        return jsonify({"error": "invalid token"}), 401


@auth_bp.route('/api/auth/users', methods=['GET'])
def api_auth_users_list():
    """List all users (admin only)."""
    if not db_writer:
        return jsonify({"users": []})
    return jsonify({"users": db_writer.list_auth_users()})


@auth_bp.route('/api/auth/users', methods=['POST'])
def api_auth_users_create():
    """Create or update a user. Body: { email, password, role? }"""
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    role = data.get("role", "client")

    if not email or not password:
        return jsonify({"error": "email and password required"}), 400
    if role not in ("client", "admin", "super_admin"):
        return jsonify({"error": "role must be 'client', 'admin', or 'super_admin'"}), 400

    pw_hash = _hash_password(password)
    if db_writer and db_writer.upsert_auth_user(email, pw_hash, role):
        return jsonify({"ok": True, "email": email, "role": role})
    return jsonify({"error": "database unavailable"}), 500


@auth_bp.route('/api/auth/users/<email>', methods=['DELETE'])
def api_auth_users_delete(email):
    """Delete a user by email."""
    if db_writer and db_writer.delete_auth_user(email.strip().lower()):
        return jsonify({"ok": True})
    return jsonify({"error": "not found or database unavailable"}), 404


# ── Feedback ──────────────────────────────────────────────────────────────────

def _extract_user_from_token():
    """Return (email, role) from the Bearer token, or (None, None)."""
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return None, None
    try:
        payload = pyjwt.decode(auth_header[7:], _JWT_SECRET, algorithms=[_JWT_ALGORITHM])
        return payload.get("email"), payload.get("role")
    except (pyjwt.ExpiredSignatureError, pyjwt.InvalidTokenError):
        return None, None


def _save_screenshot(file_storage):
    """Validate and save an uploaded screenshot. Returns relative filename or None."""
    if not file_storage or not file_storage.filename:
        return None
    ext = Path(secure_filename(file_storage.filename)).suffix.lower()
    if ext not in _ALLOWED_IMAGE_EXTS:
        return None
    # Read to check size
    data = file_storage.read()
    if len(data) > _MAX_SCREENSHOT_BYTES:
        return None
    filename = f"{_uuid.uuid4().hex}{ext}"
    dest = SCREENSHOTS_DIR / filename
    dest.write_bytes(data)
    return filename


@auth_bp.route('/api/feedback', methods=['POST'])
def api_feedback_create():
    """Submit a new feedback (multipart/form-data or JSON). Requires a valid JWT."""
    email, role = _extract_user_from_token()
    if not email:
        return jsonify({"error": "authentication required"}), 401

    # Support both multipart (with screenshot) and JSON
    if request.content_type and "multipart" in request.content_type:
        title = (request.form.get("title") or "").strip()
        comment = (request.form.get("comment") or "").strip()
        fb_type = request.form.get("type", "bug")
        scope = request.form.get("scope", "global")
        urgency = request.form.get("urgency", "medium")
        session_id = request.form.get("sessionId") or None
        screenshot_file = request.files.get("screenshot")
        screenshot_path = _save_screenshot(screenshot_file) if screenshot_file else None
    else:
        data = request.get_json(silent=True) or {}
        title = (data.get("title") or "").strip()
        comment = (data.get("comment") or "").strip()
        fb_type = data.get("type", "bug")
        scope = data.get("scope", "global")
        urgency = data.get("urgency", "medium")
        session_id = data.get("sessionId") or None
        screenshot_path = None

    if not title:
        return jsonify({"error": "title is required"}), 400
    if fb_type not in ("bug", "feature", "comment"):
        fb_type = "bug"
    if urgency not in ("low", "medium", "high"):
        urgency = "medium"

    if not db_writer:
        return jsonify({"error": "database unavailable"}), 500

    row = db_writer.create_feedback(title, comment, fb_type, scope, urgency, session_id, email, screenshot_path)
    if not row:
        return jsonify({"error": "could not save feedback"}), 500
    return jsonify({"feedback": row}), 201


@auth_bp.route('/api/feedback', methods=['GET'])
def api_feedback_list():
    """List all feedbacks — super_admin only."""
    email, role = _extract_user_from_token()
    if not email:
        return jsonify({"error": "authentication required"}), 401
    if role != "super_admin":
        return jsonify({"error": "forbidden"}), 403
    if not db_writer:
        return jsonify({"feedbacks": []})
    limit = request.args.get("limit", default=200, type=int)
    capped = max(1, min(limit, 1000))
    return jsonify({"feedbacks": db_writer.list_feedbacks(capped)})


@auth_bp.route('/api/feedback/mine', methods=['GET'])
def api_feedback_mine():
    """List the authenticated user's own feedbacks."""
    email, _role = _extract_user_from_token()
    if not email:
        return jsonify({"error": "authentication required"}), 401
    if not db_writer:
        return jsonify({"feedbacks": []})
    return jsonify({"feedbacks": db_writer.list_feedbacks_for_user(email)})


@auth_bp.route('/api/feedback/<int:feedback_id>/screenshot', methods=['GET'])
def api_feedback_screenshot(feedback_id):
    """Serve a feedback screenshot. Accepts token via header or ?t= query param."""
    # Try header first, then query param (for <img> tags)
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token_str = auth_header[7:]
    else:
        token_str = request.args.get("t", "")

    email, role = None, None
    if token_str:
        try:
            payload = pyjwt.decode(token_str, _JWT_SECRET, algorithms=[_JWT_ALGORITHM])
            email, role = payload.get("email"), payload.get("role")
        except (pyjwt.ExpiredSignatureError, pyjwt.InvalidTokenError):
            pass

    if not email:
        return jsonify({"error": "authentication required"}), 401
    if not db_writer:
        return jsonify({"error": "not found"}), 404

    # Find feedback by id in all feedbacks  
    rows = db_writer.list_feedbacks(limit=10000)
    row = next((r for r in rows if r["id"] == feedback_id), None)
    if not row:
        # try user's own feedbacks
        rows2 = db_writer.list_feedbacks_for_user(email)
        row = next((r for r in rows2 if r["id"] == feedback_id), None)
    if not row:
        return jsonify({"error": "not found"}), 404
    if role != "super_admin" and row.get("user_email") != email:
        return jsonify({"error": "forbidden"}), 403

    screenshot_path = row.get("screenshot_path")
    if not screenshot_path:
        return jsonify({"error": "no screenshot"}), 404

    full_path = SCREENSHOTS_DIR / Path(screenshot_path).name
    if not full_path.exists():
        return jsonify({"error": "file not found"}), 404

    return send_file(str(full_path))


@auth_bp.route('/api/feedback/<int:feedback_id>/response', methods=['POST'])
def api_feedback_respond(feedback_id):
    """Super admin sends a response to a feedback."""
    email, role = _extract_user_from_token()
    if not email:
        return jsonify({"error": "authentication required"}), 401
    if role != "super_admin":
        return jsonify({"error": "forbidden"}), 403

    data = request.get_json(silent=True) or {}
    response_text = (data.get("response") or "").strip()
    if not response_text:
        return jsonify({"error": "response text is required"}), 400

    if not db_writer:
        return jsonify({"error": "database unavailable"}), 500

    ok = db_writer.set_feedback_response(feedback_id, response_text)
    if not ok:
        return jsonify({"error": "could not save response"}), 500
    return jsonify({"ok": True})


def run_screenshot_cleanup():
    """Called by APScheduler daily to remove old screenshots."""
    if db_writer:
        db_writer.cleanup_old_screenshots(str(SCREENSHOTS_DIR), max_age_days=15)
