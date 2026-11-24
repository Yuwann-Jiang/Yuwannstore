"""Adapter for the AgentBeats Werewolf Arena green agent (A2A purple agent).

The green agent sends a plain-text prompt per phase and expects a single JSON
object back. This module turns those prompts into our own decisions, so the same
logic can be unit-tested without the A2A transport.
"""

import json
import re

PHASE_WEREWOLF = "werewolf"
PHASE_SEER = "seer"
PHASE_DOCTOR = "doctor"
PHASE_BID = "bid"
PHASE_DEBATE = "debate"
PHASE_VOTE = "vote"

_ID = re.compile(r"^\s*-\s+(\S+)\s*$", re.M)
_BARE = re.compile(r"^\s*([A-Za-z0-9_-]{4,36})\s*$", re.M)
_PLAYER = re.compile(r"Your player ID:\s*(\S+)")
_ROLE = re.compile(r"Your role is:\s*(\w+)|Your role:\s*(\w+)")
_HISTORY = re.compile(r"^\s*(\S+?)\s*(?:-|:)\s+(.+)$", re.M)
_SECTION = re.compile(r"(?:players to choose from|Participants you have not checked|"
                      r"conversations from this round|Conversation so far|"
                      r"Players you can save)\s*:?\s*\n(.*?)(?:\n\s*\n|\Z)", re.S | re.I)
_KILL = re.compile(r"Last night,\s*(\S+)\s*(was eliminated|was targeted)")


def player_id_of(prompt):
    found = _PLAYER.search(prompt or "")
    return found.group(1) if found else None


def parse_prompt(text):
    """Pull the parts we need out of one green-agent prompt."""
    prompt = text or ""
    if "YOU ARE THE WEREWOLF" in prompt:
        phase = PHASE_WEREWOLF
    elif "YOU ARE THE SEER" in prompt:
        phase = PHASE_SEER
    elif "YOU ARE THE DOCTOR" in prompt:
        phase = PHASE_DOCTOR
    elif "place your bid" in prompt:
        phase = PHASE_BID
    elif "Debate Phase" in prompt:
        phase = PHASE_DEBATE
    elif "time to vote" in prompt:
        phase = PHASE_VOTE
    else:
        phase = None
    player = _PLAYER.search(prompt)
    role = _ROLE.search(prompt)
    history = [
        (sender, content.strip())
        for sender, content in _HISTORY.findall(prompt)
        if sender not in {"-", ""}
    ]
    candidates = [c for c in _ID.findall(prompt)]
    if not candidates:
        for block in _SECTION.findall(prompt):
            found = [name for name in _BARE.findall(block)]
            candidates.extend(found)
    candidates = list(dict.fromkeys(c for c in candidates if c != player_id_of(prompt)))
    kill = _KILL.search(prompt)
    return {
        "phase": phase,
        "player": player.group(1) if player else None,
        "role": (role.group(1) or role.group(2)) if role else None,
        "candidates": candidates,
        "history": history,
        "night": kill.group(0) if kill else "",
    }


def _mentions(text, candidates):
    return [c for c in candidates if c and c in text]


def decide(parsed):
    """Choice of action for one prompt, using the same habits as our own agent."""
    phase = parsed["phase"]
    candidates = parsed["candidates"]
    me = parsed["player"]
    history = parsed["history"]

    if phase == PHASE_BID:
        # Speak up when we were just addressed or have something to defend.
        said = sum(1 for sender, _ in history if sender == me)
        addressed = any(me and me in content for _, content in history[-2:])
        amount = 100 if addressed else (40 if said == 0 else 10)
        return {"bid_amount": amount, "reason": "被点名需要回应" if addressed else "先观察，信息不足"}

    if phase == PHASE_DEBATE:
        named = []
        for sender, content in history:
            if sender != me:
                named.append(sender)
        targets = list(dict.fromkeys(named))[:2]
        if targets:
            message = (
                f"我是{parsed['role']}。{'、'.join(targets)}刚才的发言我先记下，"
                f"谁只给结论不给依据、谁急着把票压给别人，我会重点看。今天先听完再定票。"
            )
        else:
            message = "首夜信息少，我先听完一轮，谁只给结论不给依据我记一笔。"
        return {"message": message}

    if not candidates:
        return {"player_id": me or "", "reason": "没有可选目标"}

    # Night / vote: follow the table's pressure, never ourselves.
    pressure = {}
    for _, content in history:
        for name in _mentions(content, candidates):
            pressure[name] = pressure.get(name, 0) + 1
    if phase == PHASE_VOTE:
        ranked = sorted(candidates, key=lambda c: (-pressure.get(c, 0), c))
        if parsesafe := [c for c in ranked if c != me]:
            target = parsesafe[0]
        else:
            target = candidates[0]
        return {"player_id": target, "reason": f"本轮讨论里指向{target}的质疑最集中"}

    if phase == PHASE_SEER:
        ranked = sorted(candidates, key=lambda c: (-pressure.get(c, 0), c))
        target = ranked[0]
        return {"player_id": target, "reason": f"{target}被提及最多，优先验证"}

    # Werewolf kill: hit the loudest talker that is not a partner of the plot.
    ranked = sorted(candidates, key=lambda c: (-pressure.get(c, 0), c))
    target = ranked[0]
    return {"player_id": target, "reason": f"{target}场上存在感最强，先清掉带节奏的人"}


def answer(prompt, dumps=True):
    """Full round trip: prompt text in, JSON (string) out."""
    result = decide(parse_prompt(prompt))
    return json.dumps(result, ensure_ascii=False) if dumps else result
