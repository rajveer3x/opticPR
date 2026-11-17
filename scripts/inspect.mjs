const id = process.argv[2];
if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
  console.error('Usage: pnpm run:inspect <run-id>'); process.exitCode = 1;
} else {
  try {
    const response = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/api/runs/${id}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Report request returned HTTP ${response.status}`);
    console.log(JSON.stringify(await response.json(), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
