// DOIT rester le tout premier import : installe globalThis.crypto.getRandomValues
// (absent par defaut sur Hermes) - src/crypto/protocol.ts (via @noble/curves)
// en depend pour generer des cles. Voir docs/lot10/01-protocole.md.
import 'react-native-get-random-values';

import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
