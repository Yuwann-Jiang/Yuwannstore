import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lab.agentbeats import answer, parse_prompt  # noqa: E402

WEREWOLF = """You are a participant in a game of werewolf.
Your player ID: a1b2
Your role: WEREWOLF
YOU ARE THE WEREWOLF
Pick one participant to eliminate. Here is a list of the participants:
- c3d4
- e5f6"""

VOTE = """Your player ID: a1b2
Your role is: VILLAGER
It's time to vote for a player to eliminate.
Here is all of the conversations from this round:
c3d4 - 我觉得 e5f6 发言很空
e5f6 - c3d4 你才空
Here are the players to choose from:
c3d4
e5f6
g7h8"""

BID = """Your player ID: a1b2
Your role is: SEER
It is time to place your bid for speaking order in the upcoming debate round.
Current bids from other participants:
- Participant c3d4: 50 points"""

DEBATE = """Your player ID: a1b2
Your role is: SEER
ROUND 1 - Debate Phase
Conversation so far:
c3d4: 我先听一轮"""


def test_phases_are_recognised():
    assert parse_prompt(WEREWOLF)["phase"] == "werewolf"
    assert parse_prompt(VOTE)["phase"] == "vote"
    assert parse_prompt(BID)["phase"] == "bid"
    assert parse_prompt(DEBATE)["phase"] == "debate"


def test_candidates_exclude_self():
    parsed = parse_prompt(VOTE)
    assert parsed["candidates"] == ["c3d4", "e5f6", "g7h8"]


def test_vote_follows_the_pressure_and_never_self():
    parsed = json.loads(answer(VOTE))
    assert parsed["player_id"] in {"c3d4", "e5f6"}
    assert parsed["player_id"] != "a1b2"
    assert parsed["reason"]


def test_bid_and_debate_shapes():
    assert set(json.loads(answer(BID))) == {"bid_amount", "reason"}
    assert "message" in json.loads(answer(DEBATE))


def test_night_target_is_a_participant():
    parsed = json.loads(answer(WEREWOLF))
    assert parsed["player_id"] in {"c3d4", "e5f6"}
