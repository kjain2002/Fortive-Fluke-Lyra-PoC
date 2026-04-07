"""Authentication utilities — mirrors the existing app's EasyAuth header extraction."""
import os
from quart import request


def get_authenticated_user_details():
    """Extract user details from Azure App Service EasyAuth headers."""
    user_details = {
        "user_principal_id": request.headers.get("X-Ms-Client-Principal-Id", "anonymous"),
        "user_name": request.headers.get("X-Ms-Client-Principal-Name", "anonymous"),
        "auth_provider": request.headers.get("X-Ms-Client-Principal-Idp", "none"),
        "auth_token": request.headers.get("X-Ms-Token-Aad-Id-Token", ""),
    }
    return user_details
