// Workshop triage in Go. Each question below has one planted mistake.
package triage

type Question struct {
	Type         string `json:"type"`
	Instructions string `json:"instructions,omitempty"`
	Criteria     any    `json:"criteria,omitempty"`
}

func request(note string, mechanic string) map[string]any {
	return map[string]any{
		// JEV001: an alias moves to each new release.
		"model": "jev-latest",
		"state": map[string]any{"note": note},
		"questions": map[string]Question{
			// JEV004: nothing to pick when the job is neither of these.
			"job_type": {
				Type:         "choice",
				Instructions: "What kind of job is this?",
				Criteria: map[string]string{
					"wheels": "Wheel truing, spokes, hubs or tyres",
					"brakes": "Pads, cables, levers or discs",
				},
			},
			// JEV008: bare numbers say nothing about what each level means.
			"hurry": {
				Type:         "score",
				Instructions: "How soon does the customer need the bike back?",
				Criteria:     []string{"1", "2", "3"},
			},
			// JEV000: the wording is only known when this runs.
			"for_mechanic": {Type: "noul", Instructions: "Is this a job " + mechanic + " takes?"},
			// JEV006: a Score takes an ordered list, not a map.
			"wear": {
				Type:         "score",
				Instructions: "How worn is the drivetrain?",
				Criteria:     map[string]string{"light": "Chain only", "heavy": "Chain, cassette and rings"},
			},
		},
	}
}

// The same request pasted as text. JEV009: one option leaves no decision to make.
const frame = `{
	"questions": {
		"frame": {
			"type": "choice",
			"instructions": "What is the frame made of?",
			"criteria": { "steel": "A steel frame" }
		}
	}
}`
