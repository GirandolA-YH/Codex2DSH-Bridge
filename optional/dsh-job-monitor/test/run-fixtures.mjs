import { installFixtureConfig } from './helpers/fixtureConfig.mjs';
installFixtureConfig();
await import('./run-embedded.mjs');
