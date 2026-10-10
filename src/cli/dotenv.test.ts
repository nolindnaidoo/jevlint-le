import { describe, expect, it } from 'vitest';
import { keyFrom, keyPlaces, parseDotEnv } from './dotenv';
import type { Files } from './files';

function disk(tree: Record<string, string>): Files {
	return {
		stat: (path) =>
			tree[path] === undefined
				? undefined
				: { kind: 'file', size: tree[path].length },
		list: () => [],
		read: (path) => tree[path] ?? '',
		write: () => {
			throw new Error('never written');
		},
	};
}

describe('parseDotEnv', () => {
	it('reads the forms dotenv files are written in', () => {
		expect(
			parseDotEnv(
				[
					'# a comment',
					'',
					'TYPESAFE_API_KEY=apikey_bare',
					'export OPENAI_API_KEY="sk-quoted" # trailing',
					"SINGLE='it is'",
					'SPACED = padded   # note',
					'HASH=a#b',
					'not a line',
					'1BAD=x',
				].join('\n'),
			),
		).toEqual({
			TYPESAFE_API_KEY: 'apikey_bare',
			OPENAI_API_KEY: 'sk-quoted',
			SINGLE: 'it is',
			SPACED: 'padded',
			HASH: 'a#b',
		});
	});

	it('takes the last of a repeated key, and reads CRLF', () => {
		expect(parseDotEnv('A=1\r\nA=2\r\n')).toEqual({ A: '2' });
	});
});

describe('keyFrom', () => {
	it('prefers the environment, then .env.local, then .env', () => {
		const files = disk({
			'.env': 'TYPESAFE_API_KEY=from_env_file',
			'.env.local': 'TYPESAFE_API_KEY=from_local',
		});
		expect(
			keyFrom('TYPESAFE_API_KEY', { TYPESAFE_API_KEY: 'from_process' }, files),
		).toEqual({ key: 'from_process', source: 'the environment' });
		expect(keyFrom('TYPESAFE_API_KEY', {}, files)).toEqual({
			key: 'from_local',
			source: '.env.local',
		});
		expect(
			keyFrom(
				'TYPESAFE_API_KEY',
				{},
				disk({ '.env': 'TYPESAFE_API_KEY=from_env_file' }),
			),
		).toEqual({ key: 'from_env_file', source: '.env' });
	});

	it('treats a blank value as no key, wherever it is', () => {
		const files = disk({ '.env.local': 'TYPESAFE_API_KEY=  ', '.env': '' });
		expect(keyFrom('TYPESAFE_API_KEY', { TYPESAFE_API_KEY: ' ' }, files)).toBe(
			undefined,
		);
	});

	it('reads only the key asked for', () => {
		const files = disk({ '.env': 'TYPESAFE_API_KEY=jev_key' });
		expect(keyFrom('OPENAI_API_KEY', {}, files)).toBe(undefined);
	});

	it('names every place it looked, and never a key', () => {
		expect(keyPlaces('OPENAI_API_KEY')).toBe(
			'OPENAI_API_KEY in the environment the server was started with, or in .env.local or .env in its working directory',
		);
	});
});
