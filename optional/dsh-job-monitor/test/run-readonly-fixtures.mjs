import { installFixtureConfig } from './helpers/fixtureConfig.mjs';
installFixtureConfig();
await import('./readonly-recheck.mjs');
