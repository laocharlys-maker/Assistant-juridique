import React, { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet } from "react-native";
import {
  pinDejaConfigure,
  configurerPin,
  verifierPin,
  biometrieDisponible,
  authentifierParBiometrie,
} from "../lock/lock";

/**
 * Écran de verrouillage (Prompt 3, objectif C) - premier écran affiché à
 * chaque lancement/déverrouillage. Rien d'autre dans l'app n'est accessible
 * avant que `onDeverrouille()` soit appelé.
 */
export default function VerrouillageScreen({ onDeverrouille }: { onDeverrouille: () => void }) {
  const [pin, setPin] = useState("");
  const [pinConfirmation, setPinConfirmation] = useState("");
  const [modePremiereConfiguration, setModePremiereConfiguration] = useState<boolean | null>(null);
  const [biometrieProposee, setBiometrieProposee] = useState(false);
  const [erreur, setErreur] = useState("");

  useEffect(() => {
    (async () => {
      const dejaConfigure = await pinDejaConfigure();
      setModePremiereConfiguration(!dejaConfigure);
      if (dejaConfigure && (await biometrieDisponible())) {
        setBiometrieProposee(true);
      }
    })();
  }, []);

  async function tenterBiometrie() {
    const ok = await authentifierParBiometrie();
    if (ok) onDeverrouille();
  }

  async function valider() {
    setErreur("");
    if (modePremiereConfiguration) {
      if (pin.length < 4) {
        setErreur("Le code doit faire au moins 4 chiffres.");
        return;
      }
      if (pin !== pinConfirmation) {
        setErreur("Les deux codes ne correspondent pas.");
        return;
      }
      try {
        await configurerPin(pin);
        onDeverrouille();
      } catch {
        setErreur("Code invalide (4 à 8 chiffres uniquement).");
      }
      return;
    }

    const ok = await verifierPin(pin);
    if (ok) {
      onDeverrouille();
    } else {
      setErreur("Code incorrect.");
      setPin("");
    }
  }

  if (modePremiereConfiguration === null) {
    return <View style={styles.conteneur} />;
  }

  return (
    <View style={styles.conteneur}>
      <Text style={styles.titre}>Aurore Mobile</Text>
      <Text style={styles.sousTitre}>
        {modePremiereConfiguration ? "Choisissez un code PIN (4 à 8 chiffres)" : "Entrez votre code PIN"}
      </Text>
      <TextInput
        style={styles.champPin}
        value={pin}
        onChangeText={setPin}
        keyboardType="number-pad"
        secureTextEntry
        maxLength={8}
        autoFocus
      />
      {modePremiereConfiguration && (
        <TextInput
          style={styles.champPin}
          value={pinConfirmation}
          onChangeText={setPinConfirmation}
          keyboardType="number-pad"
          secureTextEntry
          maxLength={8}
          placeholder="Confirmer le code"
        />
      )}
      {erreur ? <Text style={styles.erreur}>{erreur}</Text> : null}
      <Pressable style={styles.bouton} onPress={valider}>
        <Text style={styles.boutonTexte}>{modePremiereConfiguration ? "Créer le code" : "Déverrouiller"}</Text>
      </Pressable>
      {biometrieProposee && (
        <Pressable style={styles.boutonSecondaire} onPress={tenterBiometrie}>
          <Text style={styles.boutonSecondaireTexte}>Utiliser la biométrie</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  conteneur: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24, backgroundColor: "#0b1220" },
  titre: { fontSize: 28, fontWeight: "700", color: "#fff", marginBottom: 8 },
  sousTitre: { fontSize: 15, color: "#9aa5b1", marginBottom: 24, textAlign: "center" },
  champPin: {
    width: "100%",
    maxWidth: 240,
    borderWidth: 1,
    borderColor: "#2a3545",
    borderRadius: 10,
    padding: 14,
    fontSize: 20,
    textAlign: "center",
    color: "#fff",
    marginBottom: 12,
    letterSpacing: 6,
  },
  erreur: { color: "#ff6b6b", marginBottom: 12 },
  bouton: { backgroundColor: "#3b82f6", paddingVertical: 14, paddingHorizontal: 32, borderRadius: 10, marginTop: 8 },
  boutonTexte: { color: "#fff", fontSize: 16, fontWeight: "600" },
  boutonSecondaire: { marginTop: 16 },
  boutonSecondaireTexte: { color: "#9aa5b1", fontSize: 14, textDecorationLine: "underline" },
});
