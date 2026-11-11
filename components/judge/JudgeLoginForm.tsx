"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Field";
import { JudgeApiError, judgeLogin } from "./api";

/** `next` is already reduced to a same-site relative path by the server page (lib/auth/judge.ts `safeNextPath`). */
export function JudgeLoginForm({ next }: { next: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      await judgeLogin(username, password);
      // A full navigation, so every server-rendered page sees the new session cookie.
      window.location.assign(next);
    } catch (e) {
      setError(e instanceof JudgeApiError ? e.message : "Could not reach Outings. Check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <form
      className="mt-6 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void signIn();
      }}
    >
      <TextField label="Username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} required />
      <TextField label="Password" name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      {error && (
        <p role="alert" className="text-small font-semibold text-danger">
          {error}
        </p>
      )}
      <Button type="submit" block loading={busy} loadingLabel="Signing in" disabled={!username || !password}>
        Sign in
      </Button>
    </form>
  );
}
