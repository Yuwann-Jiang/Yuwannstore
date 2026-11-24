"""Minimal A2A purple agent for AgentBeats Werewolf Arena.

The green agent talks to us with one text prompt per phase and expects a single
JSON object back; `agentbeats.answer()` produces that. This file only wires the
A2A transport, so it needs `a2a-sdk` installed (see AGENTBEATS.md).

Run:
    python -m lab.serve_agentbeats --port 9999
"""

import argparse

from .agentbeats import answer


def build_app():
    from a2a.server.agent_execution import AgentExecutor, RequestContext
    from a2a.server.apps import A2AStarletteApplication
    from a2a.server.events import EventQueue
    from a2a.server.request_handlers import DefaultRequestHandler
    from a2a.server.tasks import InMemoryTaskStore
    from a2a.types import AgentCapabilities, AgentCard, AgentSkill
    from a2a.utils import new_agent_text_message

    class WerewolfExecutor(AgentExecutor):
        async def execute(self, context: "RequestContext", event_queue: "EventQueue") -> None:
            prompt = context.get_user_input()
            await event_queue.enqueue_event(new_agent_text_message(answer(prompt)))

        async def cancel(self, context, event_queue) -> None:  # pragma: no cover
            raise NotImplementedError("werewolf evaluation has no cancel path")

    card = AgentCard(
        name="langrensha-werewolf",
        description="Werewolf Arena participant: returns per-phase JSON decisions.",
        url="http://0.0.0.0:9999/",
        version="0.1.0",
        default_input_modes=["text/plain"],
        default_output_modes=["text/plain"],
        capabilities=AgentCapabilities(streaming=False),
        skills=[AgentSkill(id="werewolf", name="werewolf", description="play werewolf",
                           tags=["game"], examples=["vote", "debate", "bid"])],
    )
    handler = DefaultRequestHandler(agent_executor=WerewolfExecutor(), task_store=InMemoryTaskStore())
    return A2AStarletteApplication(agent_card=card, http_handler=handler).build()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=9999)
    args = parser.parse_args()
    import uvicorn

    uvicorn.run(build_app(), host="0.0.0.0", port=args.port)


if __name__ == "__main__":
    main()
