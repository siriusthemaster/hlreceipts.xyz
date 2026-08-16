/** Skeleton účtenky — pulzujúce riadky, zámerne žiadny spinner. */
export default function Loading() {
  return (
    <main className="wrap">
      <div className="row" style={{ padding: 0 }}>
        <span className="label">HLRECEIPTS.XYZ</span>
        <div className="skel" style={{ width: 96 }} />
      </div>

      <hr className="perf" />
      <div className="label" style={{ marginBottom: 12 }}>THE DAMAGE</div>
      <div className="skel" style={{ height: 46, width: '68%', marginBottom: 14 }} />
      <div className="skel" style={{ width: '46%' }} />

      {['BREAKDOWN', 'THE WOUNDS', 'COVERAGE'].map((s) => (
        <div key={s}>
          <hr className="perf" />
          <div className="label" style={{ marginBottom: 12 }}>{s}</div>
          {[0, 1, 2].map((i) => (
            <div className="row" key={i}>
              <div className="skel" style={{ width: '38%' }} />
              <div className="skel" style={{ width: '24%' }} />
            </div>
          ))}
        </div>
      ))}

      <hr className="perf" />
      <div className="muted" style={{ fontSize: 12 }}>counting every fill since day one…</div>
    </main>
  )
}
