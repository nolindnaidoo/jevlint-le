"""Workshop triage with the Python SDK. Each question below has one planted mistake."""

from typesafe_sdk import Choice, Noul, Score, TypeSafeClient

client = TypeSafeClient()


def triage(note: str, mechanic: str):
    return client.system_one(
        {"note": note},
        {
            # JEV004: nothing to pick when the job is neither of these.
            "job_type": Choice(
                instructions="What kind of job is this?",
                criteria={
                    "wheels": "Wheel truing, spokes, hubs or tyres",
                    "brakes": "Pads, cables, levers or discs",
                },
            ),
            # JEV008: bare numbers say nothing about what each level means.
            "hurry": Score(
                instructions="How soon does the customer need the bike back?",
                criteria=["1", "2", "3"],
            ),
            # JEV000: the wording is only known when this runs.
            "for_mechanic": Noul(instructions=f"Is this a job {mechanic} takes?"),
            # JEV009: one option leaves no decision to make.
            "frame": Choice(
                instructions="What is the frame made of?",
                criteria={"steel": "A steel frame"},
            ),
            # JEV006: a Score takes an ordered list, not a dict.
            "wear": Score(
                instructions="How worn is the drivetrain?",
                criteria={"light": "Chain only", "heavy": "Chain, cassette and rings"},
            ),
            "has_deadline": Noul(instructions="Does the customer name a day?"),
            # JEV005: the second entry replaces the first without a word.
            "has_deadline": Noul(instructions="Is a pickup day given?"),
        },
        # JEV001: an alias moves to each new release.
        model="jev-latest",
    )
