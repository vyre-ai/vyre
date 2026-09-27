import type { ReactNode } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, View } from "react-native";

/** Native: the system moves the composer with the keyboard; the inverted list keeps the tail in view. */
export function Frame({ transcript, composer }: { transcript: ReactNode; composer: ReactNode }) {
  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.fill}>{transcript}</View>
      {composer}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
