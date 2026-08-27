import json


def sse_event(event: str, payload: object, event_id: str | None = None) -> str:
    identifier = f"id: {event_id}\n" if event_id else ""
    return (
        f"{identifier}event: {event}\n"
        f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
    )
