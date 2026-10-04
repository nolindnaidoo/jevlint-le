import { choice, noul, TypeSafeClient } from '@typesafe-ai/sdk';

const client = new TypeSafeClient();

export function route(note: string) {
	return client.systemOne({
		state: { note },
		model: 'jev-latest',
		questions: {
			team: choice('Which team should handle this?', {
				billing: 'Charges and refunds',
				delivery: 'Late or damaged parcels',
			}),
			late: noul('Did more than two parcels arrive late?'),
		},
	});
}
