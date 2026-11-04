"use client"

import { useApi } from "../api"
import { LineChart, StackedArea } from "../charts"
import { Card, ErrorCard, Loading, TimeChart } from "../common"
import { fmtMoney, fmtNum, fmtPct } from "../format"
import { pts, useDash } from "../state"

const EDU = ["none", "primary", "secondary", "vocational", "bachelor", "graduate"]
const EDU_LABELS = ["No schooling", "Primary", "Secondary", "Vocational", "Bachelor", "Graduate"]

interface OccDetail {
  lf: number
  emp: number
  skill: number
  inactive: number
  wage: number
  edu: number[]
  vacancies?: number
}

export function LaborView() {
  const d = useDash()
  const ax = d.axis
  const r = useApi<{ tick: number | null; data: Record<string, OccDetail> | null }>(
    `/api/timelines/${d.tid}/detail/labor?tick=${d.cursor + 1}&v=${d.version}`,
  )
  if (r.error) return <ErrorCard error={r.error} />
  const rows = Object.entries(r.data?.data ?? {})
    .map(([o, v]) => ({
      o,
      name: d.by.occupations[o]?.name ?? o,
      ...v,
      u: v.lf ? 1 - v.emp / v.lf : 0,
    }))
    .toSorted((a, b) => b.lf - a.lf)
  return (
    <>
      <h1>Labor, talent &amp; education</h1>
      <p className="lead">
        People are agents with an education level, a field of study, an occupation and skills that
        grow on the job and fade in unemployment. Schools are only as good as the teachers the
        education budget hires; students choose fields by expected wages and the seats you fund.
      </p>
      {d.series.length > 0 && (
        <div className="grid g2">
          <Card title="Education attainment of adults (25+)">
            <StackedArea
              x={d.series.map((m) => m.tick)}
              xfmt={ax.xfmt}
              xticks={ax.xticks}
              yfmt={(v) => fmtPct(v, 0)}
              height={220}
              series={EDU_LABELS.map((n, i) => ({
                name: n,
                values: d.series.map((m) => m.edu_attainment[i] ?? 0),
              }))}
            />
          </Card>
          <Card title="Average years of schooling & tertiary share">
            <TimeChart
              defs={[{ name: "Avg years of schooling", key: "avg_school_years" }]}
              yfmt={(v) => v.toFixed(1)}
              zero={false}
              height={150}
            />
            <LineChart
              series={[
                {
                  name: "Adults with a degree",
                  points: pts(d.series, "tertiary_share"),
                  color: "var(--series-3)",
                },
              ]}
              xfmt={ax.xfmt}
              xticks={ax.xticks}
              yfmt={(v) => fmtPct(v, 0)}
              height={130}
            />
          </Card>
          <Card title="Average & median wage" sub="nominal, monthly">
            <TimeChart
              defs={[
                { name: "Average wage", key: "avg_wage" },
                { name: "Median wage", key: "median_wage", color: "var(--series-2)" },
              ]}
              yfmt={fmtMoney}
            />
          </Card>
          <Card title="Immigration & emigration" sub="people / month">
            <TimeChart
              defs={[
                { name: "Immigrants", key: "immigrants" },
                { name: "Emigrants", key: "emigrants", color: "var(--series-2)" },
              ]}
              yfmt={fmtNum}
            />
          </Card>
        </div>
      )}
      <Card
        title="Occupations"
        sub={r.data?.tick !== null && r.data?.tick !== undefined ? ax.tickLabel(r.data.tick) : ""}
        style={{ marginTop: 14 }}
      >
        {!r.data ? (
          <Loading />
        ) : (
          <div className="scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Occupation</th>
                  <th className="num">Labor force</th>
                  <th className="num">Employed</th>
                  <th className="num">Unemployment</th>
                  <th className="num">Vacancies</th>
                  <th className="num">Wage / month</th>
                  <th className="num">Avg skill</th>
                  <th className="num">Min. education</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.o}>
                    <td>{x.name}</td>
                    <td className="num">{fmtNum(x.lf)}</td>
                    <td className="num">{fmtNum(x.emp)}</td>
                    <td className="num">{fmtPct(x.u)}</td>
                    <td className="num">{fmtNum(x.vacancies ?? 0)}</td>
                    <td className="num">{fmtMoney(x.wage)}</td>
                    <td className="num">{x.skill.toFixed(2)}</td>
                    <td className="num">{EDU[d.by.occupations[x.o]?.edu ?? 0]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}
