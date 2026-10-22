// No web UI: everything happens in Telegram. This page only confirms the deploy is alive.
export default function Home() {
  return (
    <main style={{ padding: 32, fontFamily: "system-ui, sans-serif" }}>
      <h1>LinkBot is running</h1>
      <p>Open the bot in Telegram to use it.</p>
    </main>
  );
}
