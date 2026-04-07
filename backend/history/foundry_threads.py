"""Foundry Conversations API history service — replaces CosmosDB for Approach B.

Uses the Foundry new experience Conversations API for conversation memory.
The lyra-testing agent is referenced but tool execution stays local.
"""
import uuid
from datetime import datetime
from typing import Optional

from azure.ai.projects import AIProjectClient
from azure.identity import DefaultAzureCredential


class FoundryConversationClient:
    def __init__(self, project_endpoint: str, agent_name: str, agent_version: str = "1"):
        self.project_endpoint = project_endpoint
        self.agent_name = agent_name
        self.agent_version = agent_version
        self._project_client: Optional[AIProjectClient] = None
        self._openai_client = None
        # Local metadata store for conversation titles/dates (Foundry doesn't store titles)
        self._conversations: dict[str, dict] = {}

    async def ensure(self):
        """Initialise the Foundry clients."""
        if self._project_client is not None:
            return True
        self._project_client = AIProjectClient(
            endpoint=self.project_endpoint,
            credential=DefaultAzureCredential(),
        )
        self._openai_client = self._project_client.get_openai_client()
        return True

    async def create_conversation(self, user_id: str, title: str = "") -> dict:
        """Create a new Foundry conversation thread."""
        conversation = self._openai_client.conversations.create()
        conv_id = conversation.id
        conv_meta = {
            "id": conv_id,
            "type": "conversation",
            "userId": user_id,
            "title": title or "New conversation",
            "createdAt": datetime.utcnow().isoformat(),
            "updatedAt": datetime.utcnow().isoformat(),
        }
        self._conversations[conv_id] = conv_meta
        return conv_meta

    async def get_conversations(self, user_id: str, offset: int = 0, limit: int = 25) -> list:
        """List conversations from local metadata (Foundry doesn't have a list API)."""
        convs = sorted(
            self._conversations.values(),
            key=lambda c: c.get("updatedAt", ""),
            reverse=True,
        )
        return convs[offset:offset + limit]

    async def get_messages(self, conv_id: str, user_id: str) -> list:
        """Retrieve messages from the Foundry conversation thread."""
        try:
            items = self._openai_client.conversations.items.list(
                conversation_id=conv_id,
                limit=100,
            )
            messages = []
            for item in items:
                if hasattr(item, "role") and hasattr(item, "content"):
                    content_text = ""
                    if isinstance(item.content, list):
                        for block in item.content:
                            if hasattr(block, "text"):
                                content_text += block.text
                    elif isinstance(item.content, str):
                        content_text = item.content

                    messages.append({
                        "id": getattr(item, "id", str(uuid.uuid4())),
                        "type": "message",
                        "conversationId": conv_id,
                        "userId": user_id,
                        "role": item.role,
                        "content": content_text,
                        "createdAt": datetime.utcnow().isoformat(),
                        "updatedAt": datetime.utcnow().isoformat(),
                        "feedback": "",
                    })
            # Foundry returns newest-first; reverse to chronological order
            messages.reverse()
            return messages
        except Exception as e:
            import logging
            logging.getLogger(__name__).error("Failed to retrieve Foundry messages for %s: %s", conv_id, e)
            return []

    async def delete_conversation(self, conv_id: str, user_id: str):
        """Remove conversation from local metadata. Foundry threads are immutable."""
        self._conversations.pop(conv_id, None)

    async def delete_all_conversations(self, user_id: str):
        """Clear all local conversation metadata."""
        self._conversations.clear()

    async def clear_messages(self, conv_id: str, user_id: str):
        """Foundry threads are append-only; remove from local tracking."""
        self._conversations.pop(conv_id, None)

    async def update_message_feedback(self, message_id: str, feedback: str):
        """Feedback is UI-only; Foundry doesn't store it. No-op for now."""
        return None

    async def update_conversation_title(self, conv_id: str, title: str):
        """Update title in local metadata."""
        if conv_id in self._conversations:
            self._conversations[conv_id]["title"] = title
            self._conversations[conv_id]["updatedAt"] = datetime.utcnow().isoformat()

    async def close(self):
        """Clean up."""
        self._project_client = None
        self._openai_client = None
