"""Settings for the hierarchical search chatbot."""
import os
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class SearchSettings:
    endpoint: str = ""
    index: str = "video-transcripts-hierarchical-v2"
    api_version: str = "2024-07-01"

    def __post_init__(self):
        self.endpoint = os.environ.get("SEARCH_ENDPOINT", self.endpoint).rstrip("/")
        self.index = os.environ.get("SEARCH_INDEX", self.index)


@dataclass
class AzureOpenAISettings:
    endpoint: str = ""
    chat_deployment: str = "gpt-5.1"
    api_version: str = "2024-06-01"
    temperature: float = 0
    max_tokens: int = 4096
    max_iterations: int = 8

    def __post_init__(self):
        self.endpoint = os.environ.get("AOAI_ENDPOINT", self.endpoint)
        self.chat_deployment = os.environ.get("CHAT_DEPLOYMENT", self.chat_deployment)
        self.temperature = float(os.environ.get("AZURE_OPENAI_TEMPERATURE", self.temperature))
        self.max_tokens = int(os.environ.get("AZURE_OPENAI_MAX_TOKENS", self.max_tokens))
        self.max_iterations = int(os.environ.get("MAX_ITERATIONS", self.max_iterations))


@dataclass
class UISettings:
    title: str = "Hierarchical Search"
    chat_title: str = "Video Transcript Explorer"
    chat_description: list = field(default_factory=lambda: [
        "Ask questions about solar project meeting recordings.",
        "The AI agent uses a hierarchical search index with project, video (VoC), and chunk levels.",
        "It can discover projects, summarise videos, search transcripts, and compare across projects.",
        "Try: 'What projects are available?' or 'Summarize the ATUM project'",
    ])
    logo: str = ""
    chat_logo: str = ""
    show_share_button: bool = False

    def __post_init__(self):
        self.title = os.environ.get("UI_TITLE", self.title)
        self.chat_title = os.environ.get("UI_CHAT_TITLE", self.chat_title)
        desc = os.environ.get("UI_CHAT_DESCRIPTION", "")
        if desc:
            import json
            try:
                self.chat_description = json.loads(desc)
            except (json.JSONDecodeError, TypeError):
                pass
        self.logo = os.environ.get("UI_LOGO", self.logo)
        self.chat_logo = os.environ.get("UI_CHAT_LOGO", self.chat_logo)


@dataclass
class FoundrySettings:
    project_endpoint: str = ""
    agent_name: str = "lyra-testing"
    agent_version: str = "1"

    def __post_init__(self):
        self.project_endpoint = os.environ.get(
            "FOUNDRY_PROJECT_ENDPOINT",
            self.project_endpoint,
        )
        self.agent_name = os.environ.get("FOUNDRY_AGENT_NAME", self.agent_name)
        self.agent_version = os.environ.get("FOUNDRY_AGENT_VERSION", self.agent_version)


@dataclass
class AppSettings:
    search: SearchSettings = field(default_factory=SearchSettings)
    azure_openai: AzureOpenAISettings = field(default_factory=AzureOpenAISettings)
    foundry: FoundrySettings = field(default_factory=FoundrySettings)
    ui: UISettings = field(default_factory=UISettings)
    auth_enabled: bool = False
    feedback_enabled: bool = True
    sanitize_answer: bool = False

    def __post_init__(self):
        self.auth_enabled = os.environ.get("AUTH_ENABLED", "false").lower() == "true"
        self.feedback_enabled = os.environ.get("FOUNDRY_ENABLE_FEEDBACK", "true").lower() == "true"
