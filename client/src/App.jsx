import { useEffect, useState } from 'react'

function App() {
  const [health, setHealth] = useState(null)

  useEffect(() => {
    fetch('/api/health')
      .then(r => r.json())
      .then(setHealth)
      .catch(() => setHealth({ ok: false }))
  }, [])

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '2rem' }}>
      <h1>AI Commerce Gateway</h1>
      <p>Stage 0 — Foundation</p>
      <p>
        API Health:{' '}
        {health === null
          ? 'Checking…'
          : health.ok
          ? '✅ OK'
          : '❌ Down'}
      </p>
    </div>
  )
}

export default App
