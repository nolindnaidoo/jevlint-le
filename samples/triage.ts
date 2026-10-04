import { choice, noul, score, TypeSafeClient } from '@typesafe-ai/sdk';

const client = new TypeSafeClient();

function askAbout(part: string): string {
	return `Does the note mention the ${part}?`;
}

export async function triage(note: string, part: string) {
	return client.systemOne({
		state: { note },
		model: 'jev-preview',
		questions: {
			job_type: choice('What kind of job is this?', {
				wheels: 'Truing, spokes, or a replacement wheel',
				brakes: 'Pads, cables, or bleeding',
			}),
			hurry: score('How soon does the customer need the bike?', ['1', '2', '3']),
			mentions_part: noul(askAbout(part)),
			// jevlint-le-disable-next-line JEV004
			drop_off: choice('Was the bike dropped off or collected?', { dropped_off: null, collected: null }),
		},
	});
}

export async function route(note: string) {
	return client.systemOne({
		state: note,
		model: 'jev-1.13.0',
		questions: {
			contact: {
				type: 'choice',
				instructions: '',
				criteria: { phone: 'The customer left a phone number' },
			},
			mood: {
				type: 'score',
				instructions: 'How put out is the customer?',
				criteria: ['Relaxed about it', 'Clearly annoyed', 'Relaxed about it'],
			},
		},
	});
}
