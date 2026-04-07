"""
Hierarchical Search Chatbot — Quart web backend.

Replicates the fluke-voc-chatbot-2 API surface while using the
tool-calling agent from the hierarchical_mcp_agent_improved notebook.
"""
import json
import logging
import os

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.DEBUG)

import uuid
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from quart import Quart, jsonify, request, send_from_directory

load_dotenv(Path(__file__).resolve().parent / ".env")

from backend.settings import AppSettings
from backend.agent import init_agent, run_agent, create_conversation
from backend.auth.auth_utils import get_authenticated_user_details
from backend.history.foundry_threads import FoundryConversationClient

# ── App init ────────────────────────────────────────────────────────────────────

app = Quart(__name__, static_folder="static")

settings = AppSettings()
init_agent(settings)

# Foundry conversation client (lazy init)
_history_client: FoundryConversationClient | None = None


async def _get_history() -> FoundryConversationClient | None:
    global _history_client
    if not settings.foundry.project_endpoint:
        return None
    if _history_client is None:
        _history_client = FoundryConversationClient(
            project_endpoint=settings.foundry.project_endpoint,
            agent_name=settings.foundry.agent_name,
            agent_version=settings.foundry.agent_version,
        )
        await _history_client.ensure()
    return _history_client


def _user_id() -> str:
    details = get_authenticated_user_details()
    return details.get("user_principal_id", "anonymous")


# ── Helpers ─────────────────────────────────────────────────────────────────────

def _generate_title(question: str) -> str:
    """Generate a short title from the first question."""
    title = question.strip()
    if len(title) > 60:
        title = title[:57] + "..."
    return title


def _format_response(
    answer: str,
    citations: list,
    tool_calls: list,
    documents: list,
    message_id: str,
    conversation_id: str,
    title: str,
    question: str = "",
) -> dict:
    """Format the agent result in the same shape the existing frontend expects."""
    return {
        "id": message_id,
        "model": settings.azure_openai.chat_deployment,
        "created": int(datetime.utcnow().timestamp()),
        "object": "chat.completion",
        "choices": [
            {
                "messages": [
                    {
                        "role": "tool",
                        "content": json.dumps({
                            "citations": citations,
                            "intent": "hierarchical_search",
                            "tool_calls": tool_calls,
                            "documents": documents,
                        }),
                    },
                    {
                        "role": "assistant",
                        "content": answer,
                        "context": json.dumps({"citations": citations}),
                        "question": question,
                    },
                ]
            }
        ],
        "history_metadata": {
            "conversation_id": conversation_id,
            "title": title,
            "date": datetime.utcnow().isoformat(),
        },
    }


# ── Chat endpoints ──────────────────────────────────────────────────────────────

@app.route("/conversation", methods=["POST"])
async def conversation():
    """Stateless conversation endpoint."""
    body = await request.get_json()
    messages = body.get("messages", [])
    if not messages:
        return jsonify({"error": "No messages provided"}), 400

    user_msg = messages[-1]
    question = user_msg.get("content", "")

    conversation_id = create_conversation()
    result = run_agent(question, conversation_id=conversation_id)

    msg_id = str(uuid.uuid4())
    resp = _format_response(
        answer=result["answer"],
        citations=result["citations"],
        tool_calls=result["tool_calls"],
        documents=result["documents"],
        message_id=msg_id,
        conversation_id=conversation_id,
        title=_generate_title(question),
        question=question,
    )
    return jsonify(resp)


@app.route("/history/generate", methods=["POST"])
async def history_generate():
    """Conversation with Foundry history persistence via Responses API."""
    body = await request.get_json()
    messages = body.get("messages", [])
    conversation_id = body.get("conversation_id")
    user_id = _user_id()

    if not messages:
        return jsonify({"error": "No messages provided"}), 400

    user_msg = messages[-1]
    question = user_msg.get("content", "")

    history = await _get_history()

    # Create or reuse conversation
    title = _generate_title(question)
    if not conversation_id:
        if history:
            conv = await history.create_conversation(user_id, title)
            conversation_id = conv["id"]
        else:
            conversation_id = create_conversation()

    # Run agent — Foundry Conversations API manages memory
    result = run_agent(question, conversation_id=conversation_id)

    msg_id = str(uuid.uuid4())
    resp = _format_response(
        answer=result["answer"],
        citations=result["citations"],
        tool_calls=result["tool_calls"],
        documents=result["documents"],
        message_id=msg_id,
        conversation_id=conversation_id,
        title=title,
        question=question,
    )

    return jsonify(resp)


# ── History endpoints ───────────────────────────────────────────────────────────

@app.route("/history/list", methods=["GET"])
async def history_list():
    history = await _get_history()
    if not history:
        return jsonify([])
    user_id = _user_id()
    offset = request.args.get("offset", 0, type=int)
    convs = await history.get_conversations(user_id, offset=offset)
    return jsonify(convs)


@app.route("/history/read", methods=["POST"])
async def history_read():
    history = await _get_history()
    if not history:
        return jsonify({"messages": []})
    body = await request.get_json()
    conv_id = body.get("conversation_id", "")
    user_id = _user_id()
    msgs = await history.get_messages(conv_id, user_id)
    return jsonify({"messages": msgs})


@app.route("/history/rename", methods=["POST"])
async def history_rename():
    history = await _get_history()
    if not history:
        return jsonify({"error": "History not configured"}), 400
    body = await request.get_json()
    conv_id = body.get("conversation_id", "")
    title = body.get("title", "")
    await history.update_conversation_title(conv_id, title)
    return jsonify({"ok": True})


@app.route("/history/delete", methods=["DELETE"])
async def history_delete():
    history = await _get_history()
    if not history:
        return jsonify({"error": "History not configured"}), 400
    body = await request.get_json()
    conv_id = body.get("conversation_id", "")
    user_id = _user_id()
    await history.delete_conversation(conv_id, user_id)
    return jsonify({"ok": True})


@app.route("/history/delete_all", methods=["DELETE"])
async def history_delete_all():
    history = await _get_history()
    if not history:
        return jsonify({"error": "History not configured"}), 400
    user_id = _user_id()
    await history.delete_all_conversations(user_id)
    return jsonify({"ok": True})


@app.route("/history/update", methods=["POST"])
async def history_update():
    """No-op — Foundry Conversations API manages message persistence natively."""
    return jsonify({"ok": True})


@app.route("/history/clear", methods=["POST"])
async def history_clear():
    history = await _get_history()
    if not history:
        return jsonify({"error": "History not configured"}), 400
    body = await request.get_json()
    conv_id = body.get("conversation_id", "")
    user_id = _user_id()
    await history.clear_messages(conv_id, user_id)
    return jsonify({"ok": True})


@app.route("/history/ensure", methods=["GET"])
async def history_ensure():
    try:
        history = await _get_history()
        if history:
            return jsonify({"message": "Foundry Conversations API is configured and working"})
        else:
            return jsonify({"error": "Foundry is not configured"}), 422
    except Exception as e:
        logger.error("history/ensure failed: %s", e)
        return jsonify({"error": str(e)}), 500


@app.route("/history/message_feedback", methods=["POST"])
async def history_message_feedback():
    history = await _get_history()
    if not history:
        return jsonify({"error": "History not configured"}), 400
    body = await request.get_json()
    message_id = body.get("message_id", "")
    feedback = body.get("message_feedback", "")
    await history.update_message_feedback(message_id, feedback)
    return jsonify({"ok": True})


# ── Frontend settings ──────────────────────────────────────────────────────────

@app.route("/frontend_settings", methods=["GET"])
async def frontend_settings():
    return jsonify({
        "auth_enabled": str(settings.auth_enabled).lower(),
        "feedback_enabled": str(settings.feedback_enabled).lower(),
        "sanitize_answer": settings.sanitize_answer,
        "ui": {
            "title": settings.ui.title,
            "chat_title": settings.ui.chat_title,
            "chat_description": settings.ui.chat_description,
            "logo": settings.ui.logo,
            "chat_logo": settings.ui.chat_logo,
            "show_share_button": settings.ui.show_share_button,
        },
    })


# ── Static file serving ────────────────────────────────────────────────────────

@app.route("/")
async def index():
    return await send_from_directory(app.static_folder, "index.html")


@app.route("/<path:path>")
async def static_proxy(path):
    try:
        return await send_from_directory(app.static_folder, path)
    except Exception:
        return await send_from_directory(app.static_folder, "index.html")


@app.route("/assets/<path:path>")
async def assets(path):
    return await send_from_directory(os.path.join(app.static_folder, "assets"), path)


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
