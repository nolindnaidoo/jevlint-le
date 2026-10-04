import { choice, noul, score, TypeSafeClient } from '@typesafe-ai/sdk';

const client = new TypeSafeClient();

// Every question here is well formed, so this file should show no findings.
export async function triage(note: string) {
	return client.systemOne({
		state: { note },
		model: 'jev-1.13.0',
		questions: {
			job_type: choice('What kind of job is this?', {
				wheels: 'Truing, spokes, or a replacement wheel',
				brakes: 'Pads, cables, or bleeding',
				other: 'Fits none of the other options',
			}),
			hurry: score('How soon does the customer need the bike?', [
				'Any time this month',
				'Some time this week',
				'Today or tomorrow',
			]),
			has_deadline: noul('Does the customer name a day they need the bike by?', {
				true: 'A day or date is given',
				false: 'No day or date is given',
			}),
		},
	});
}
