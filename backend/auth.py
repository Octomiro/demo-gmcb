import hashlib
import os
import secrets as _secrets
from datetime import datetime, timedelta

import jwt as pyjwt
from flask import Blueprint, jsonify, request

from pipeline_manager import db_writer

auth_bp = Blueprint("auth", __name__)

_JWT_SECRET = os.environ.get("JWT_SECRET") or _secrets.token_hex(32)
_JWT_ALGORITHM = "HS256"
_JWT_EXPIRY_HOURS = 24


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
    if role not in ("client", "admin"):
        return jsonify({"error": "role must be 'client' or 'admin'"}), 400

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
