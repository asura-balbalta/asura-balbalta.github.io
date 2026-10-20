import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Input, Select, Slider } from "@fluentui/react-components"
import React, { useEffect, useState } from "react"

import { isBuiltinPalette, ScenePalette } from "../scenePalette"
import type { PaletteStore } from "../usePalettes"

/** 색 입력. 브라우저 기본 색 피커(Fluent v9 에 색 피커가 없어 기본 입력을 쓴다. 계획서 13절 P3 결정) */
const ColorField = ({ value, onChange, label }: { value: string; onChange: (hex: string) => void; label: string }) => (
    <input
        type="color"
        className="ui-palette-color"
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
    />
)

const STOP_LABELS = ["수면", "강변 평지", "시가지 평지", "구릉", "산지", "고산"]

/**
 * 설정 패널의 "색상표" 줄: 색상표 고르기(내장 + 사용자)와 "편집…" 버튼. 편집은 별도 창(PaletteDialog)에서 한다(2026-10-20 결정 by @nanangqq:
 * 패널 안에 펼치면 272px 패널에서 레이아웃이 깨지고 길어진다)
 */
export const PaletteSection = ({ store }: { store: PaletteStore }) => {
    const [open, setOpen] = useState(false)
    return (
        <>
            <div className="ui-settings-row">
                <span>색상표</span>
                <span className="ui-settings-input">
                    <Select size="small" value={store.palette.id} onChange={(_, data) => store.select(data.value)} aria-label="색상표">
                        {store.palettes.map((p) => (
                            <option key={p.id} value={p.id}>
                                {p.name}
                                {isBuiltinPalette(p.id) ? "" : " (내)"}
                            </option>
                        ))}
                    </Select>
                    <Button size="small" onClick={() => setOpen(true)}>
                        편집…
                    </Button>
                </span>
            </div>
            <PaletteDialog store={store} open={open} onClose={() => setOpen(false)} />
        </>
    )
}

/**
 * 색상표 편집 창(Fluent Dialog, 출처 창과 같은 틀). 복제·이름·내장값으로·삭제, 배경·건물·도로 색, 표고 색표 6단계(높이와 색), 태양 고도,
 * 둘러보기 조명 세기 4개. 바꾸면 바로 uniform 에 반영되고(캔버스 effect) localStorage 에 저장된다(usePalettes). 창은 모달이 아니라서
 * (modalType non-modal) 열어 둔 채 3D 화면을 보며 값을 고를 수 있다. 내장 색상표를 고치면 자동으로 사본이 만들어져 그것을 고른다
 */
export const PaletteDialog = ({ store, open, onClose }: { store: PaletteStore; open: boolean; onClose: () => void }) => {
    const { palette } = store
    const builtin = isBuiltinPalette(palette.id)
    const [renaming, setRenaming] = useState(false)
    const [nameText, setNameText] = useState(palette.name)
    useEffect(() => {
        setNameText(palette.name)
        setRenaming(false)
    }, [palette.id, palette.name])
    const commitName = () => {
        const name = nameText.trim()
        if (name && name !== palette.name) store.update({ name: name.slice(0, 40) })
        setRenaming(false)
    }
    const setStop = (i: number, patch: Partial<ScenePalette["stops"][number]>) => {
        const stops = palette.stops.map((s, k) => (k === i ? { ...s, ...patch } : { ...s }))
        store.update({ stops })
    }
    const setLighting = (patch: Partial<ScenePalette["walkLighting"]>) => store.update({ walkLighting: { ...palette.walkLighting, ...patch } })

    return (
        <Dialog open={open} modalType="non-modal" onOpenChange={(_, data) => !data.open && onClose()}>
            <DialogSurface className="ui-palette-dialog">
                <DialogBody>
                    <DialogTitle>색상표 편집 · {palette.name}</DialogTitle>
                    <DialogContent>
                        <div className="ui-palette">
                            <div className="ui-palette-actions">
                                <Select size="small" value={palette.id} onChange={(_, data) => store.select(data.value)} aria-label="색상표">
                                    {store.palettes.map((p) => (
                                        <option key={p.id} value={p.id}>
                                            {p.name}
                                            {isBuiltinPalette(p.id) ? "" : " (내)"}
                                        </option>
                                    ))}
                                </Select>
                                {renaming ? (
                                    <>
                                        <Input
                                            size="small"
                                            value={nameText}
                                            onChange={(_, data) => setNameText(data.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter") commitName()
                                                if (e.key === "Escape") setRenaming(false)
                                            }}
                                            aria-label="색상표 이름"
                                            style={{ width: 140 }}
                                        />
                                        <Button size="small" appearance="primary" onClick={commitName}>
                                            확인
                                        </Button>
                                    </>
                                ) : (
                                    <>
                                        <Button size="small" onClick={() => store.duplicate()}>
                                            복제
                                        </Button>
                                        <Button size="small" disabled={builtin} onClick={() => setRenaming(true)}>
                                            이름
                                        </Button>
                                        <Button size="small" disabled={builtin} onClick={() => store.resetToBuiltin()}>
                                            내장값으로
                                        </Button>
                                        <Button size="small" disabled={builtin} onClick={() => store.remove(palette.id)}>
                                            삭제
                                        </Button>
                                    </>
                                )}
                            </div>
                            {builtin && <div className="ui-palette-note">내장 색상표를 고치면 사본이 만들어져 그것을 고릅니다.</div>}
                            <div className="ui-palette-grid">
                                <span>배경·안개</span>
                                <ColorField label="배경색" value={palette.background} onChange={(hex) => store.update({ background: hex })} />
                                <span>건물</span>
                                <ColorField label="건물색" value={palette.buildingColor} onChange={(hex) => store.update({ buildingColor: hex })} />
                                <span>도로</span>
                                <ColorField label="도로색" value={palette.roadColor} onChange={(hex) => store.update({ roadColor: hex })} />
                            </div>
                            <div className="ui-palette-head">표고 색표 (m)</div>
                            <div className="ui-palette-stops">
                                {palette.stops.map((s, i) => (
                                    <React.Fragment key={i}>
                                        <span>{STOP_LABELS[i] ?? `단계 ${i + 1}`}</span>
                                        <Input
                                            size="small"
                                            type="number"
                                            value={String(s.z)}
                                            onChange={(_, data) => {
                                                const z = Number(data.value)
                                                if (Number.isFinite(z)) setStop(i, { z })
                                            }}
                                            aria-label={`${STOP_LABELS[i] ?? i} 높이`}
                                            style={{ width: 72 }}
                                        />
                                        <ColorField label={`${STOP_LABELS[i] ?? i} 색`} value={s.hex} onChange={(hex) => setStop(i, { hex })} />
                                    </React.Fragment>
                                ))}
                            </div>
                            <div className="ui-palette-head">빛 (둘러보기)</div>
                            <div className="ui-palette-sliders">
                                <span>태양 고도</span>
                                <Slider size="small" min={-30} max={90} step={1} value={palette.sunAltitude} onChange={(_, d) => store.update({ sunAltitude: d.value })} aria-label="태양 고도" />
                                <span className="ui-palette-value">{palette.sunAltitude}°</span>
                                <span>주변광</span>
                                <Slider size="small" min={0} max={1} step={0.05} value={palette.walkLighting.ambient} onChange={(_, d) => setLighting({ ambient: d.value })} aria-label="주변광" />
                                <span className="ui-palette-value">{palette.walkLighting.ambient.toFixed(2)}</span>
                                <span>난반사</span>
                                <Slider size="small" min={0} max={1} step={0.05} value={palette.walkLighting.diffuse} onChange={(_, d) => setLighting({ diffuse: d.value })} aria-label="난반사" />
                                <span className="ui-palette-value">{palette.walkLighting.diffuse.toFixed(2)}</span>
                                <span>반구 조명</span>
                                <Slider size="small" min={0} max={1} step={0.05} value={palette.walkLighting.hemisphere} onChange={(_, d) => setLighting({ hemisphere: d.value })} aria-label="반구 조명" />
                                <span className="ui-palette-value">{palette.walkLighting.hemisphere.toFixed(2)}</span>
                                <span>안개 ×1000</span>
                                <Slider
                                    size="small"
                                    min={0}
                                    max={5}
                                    step={0.1}
                                    value={Math.round(palette.walkLighting.fogDensity * 10000) / 10}
                                    onChange={(_, d) => setLighting({ fogDensity: d.value / 1000 })}
                                    aria-label="안개 밀도"
                                />
                                <span className="ui-palette-value">{(palette.walkLighting.fogDensity * 1000).toFixed(1)}</span>
                            </div>
                        </div>
                    </DialogContent>
                    <DialogActions>
                        <Button appearance="secondary" onClick={onClose}>
                            닫기
                        </Button>
                    </DialogActions>
                </DialogBody>
            </DialogSurface>
        </Dialog>
    )
}
