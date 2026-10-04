//! Workshop triage in Rust. Each question below has one planted mistake.

use serde_json::{json, Value};

pub fn triage(note: &str, mechanic: &str) -> Value {
    json!({
        // JEV001: an alias moves to each new release.
        "model": "jev-latest",
        "state": { "note": note },
        "questions": {
            // JEV004: nothing to pick when the job is neither of these.
            "job_type": {
                "type": "choice",
                "instructions": "What kind of job is this?",
                "criteria": {
                    "wheels": "Wheel truing, spokes, hubs or tyres",
                    "brakes": "Pads, cables, levers or discs"
                }
            },
            // JEV008: bare numbers say nothing about what each level means.
            "hurry": {
                "type": "score",
                "instructions": "How soon does the customer need the bike back?",
                "criteria": ["1", "2", "3"]
            },
            // JEV000: the wording is only known when this runs.
            "for_mechanic": {
                "type": "noul",
                "instructions": format!("Is this a job {mechanic} takes?")
            },
            // JEV006: a Score takes an ordered list, not a map.
            "wear": {
                "type": "score",
                "instructions": "How worn is the drivetrain?",
                "criteria": { "light": "Chain only", "heavy": "Chain, cassette and rings" }
            }
        }
    })
}

/// The same request pasted as text. JEV009: one option leaves no decision to make.
pub const FRAME: &str = r#"{
    "questions": {
        "frame": {
            "type": "choice",
            "instructions": "What is the frame made of?",
            "criteria": { "steel": "A steel frame" }
        }
    }
}"#;
