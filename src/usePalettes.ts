import { useCallback, useEffect, useMemo, useState } from "react"

import {
    BUILTIN_PALETTES,
    builtinPalette,
    clonePalette,
    isBuiltinPalette,
    newPaletteId,
    PALETTE_STORAGE_KEYS,
    QualitySettings,
    sanitizePalette,
    sanitizeQuality,
    ScenePalette,
} from "./scenePalette"
import type { Theme } from "./terrainTheme"

/** localStorage 의 JSON 값. 없거나 깨졌으면 기본값(사생활 보호 모드 등에서 막히면 이번 세션에서만 유지) */
const readJson = <T,>(key: string, fallback: T): T => {
    try {
        const raw = localStorage.getItem(key)
        return raw === null ? fallback : (JSON.parse(raw) as T)
    } catch {
        return fallback
    }
}
const writeJson = (key: string, value: unknown) => {
    try {
        localStorage.setItem(key, JSON.stringify(value))
    } catch {
        /* 저장이 막히면 이번 세션에서만 유지된다 */
    }
}

/** 색상표 저장소(설정 패널·캔버스가 같이 쓴다). 내장 2개 + 사용자 색상표, 고른 것, 품질 설정 */
export type PaletteStore = {
    /** 내장 + 사용자 순 */
    palettes: ScenePalette[]
    /** 고른 색상표 */
    palette: ScenePalette
    select: (id: string) => void
    /**
     * 고른 색상표를 고친다. 내장 색상표를 고치면 자동으로 사본("<이름> 사본")을 만들어 그것을 고르고 고친다(내장은 그대로.
     * 2026-10-20 계획서 13절 P3 결정)
     */
    update: (patch: Partial<Omit<ScenePalette, "id">>) => void
    /** 고른 색상표의 사본을 만들어 고른다 */
    duplicate: () => void
    /** 사용자 색상표를 지운다(내장은 못 지움). 고른 것이었으면 같은 톤의 내장으로 */
    remove: (id: string) => void
    /** 사용자 색상표의 값을 같은 톤의 내장 값으로 되돌린다(이름·id 는 그대로) */
    resetToBuiltin: () => void
    quality: QualitySettings
    setQuality: (patch: Partial<QualitySettings>) => void
}

/**
 * 색상표 상태와 localStorage 저장. 처음 값은 저장된 것, 없으면 initialTone 의 내장 색상표.
 *
 * @param initialTone 저장된 선택이 없을 때의 톤
 */
export const usePalettes = (initialTone: Theme): PaletteStore => {
    const [userPalettes, setUserPalettes] = useState<ScenePalette[]>(() =>
        readJson<unknown[]>(PALETTE_STORAGE_KEYS.user, [])
            .map(sanitizePalette)
            .filter((p): p is ScenePalette => !!p && !isBuiltinPalette(p.id)),
    )
    const [selectedId, setSelectedId] = useState<string>(() => readJson<string>(PALETTE_STORAGE_KEYS.selected, initialTone))
    const [quality, setQualityState] = useState<QualitySettings>(() => sanitizeQuality(readJson(PALETTE_STORAGE_KEYS.quality, null)))

    const palettes = useMemo(() => [...BUILTIN_PALETTES, ...userPalettes], [userPalettes])
    const palette = useMemo(() => palettes.find((p) => p.id === selectedId) ?? builtinPalette(initialTone), [palettes, selectedId, initialTone])

    useEffect(() => writeJson(PALETTE_STORAGE_KEYS.user, userPalettes), [userPalettes])
    useEffect(() => writeJson(PALETTE_STORAGE_KEYS.selected, palette.id), [palette.id])
    useEffect(() => writeJson(PALETTE_STORAGE_KEYS.quality, quality), [quality])

    const select = useCallback((id: string) => setSelectedId(id), [])

    const copyOf = (p: ScenePalette): ScenePalette => ({ ...clonePalette(p), id: newPaletteId(), name: `${p.name} 사본` })

    const update = useCallback<PaletteStore["update"]>(
        (patch) => {
            if (isBuiltinPalette(palette.id)) {
                const copy = { ...copyOf(palette), ...patch }
                setUserPalettes((list) => [...list, copy])
                setSelectedId(copy.id)
                return
            }
            setUserPalettes((list) => list.map((p) => (p.id === palette.id ? { ...p, ...patch } : p)))
        },
        [palette],
    )
    const duplicate = useCallback(() => {
        const copy = copyOf(palette)
        setUserPalettes((list) => [...list, copy])
        setSelectedId(copy.id)
    }, [palette])
    const remove = useCallback(
        (id: string) => {
            if (isBuiltinPalette(id)) return
            setUserPalettes((list) => list.filter((p) => p.id !== id))
            if (palette.id === id) setSelectedId(palette.tone)
        },
        [palette],
    )
    const resetToBuiltin = useCallback(() => {
        if (isBuiltinPalette(palette.id)) return
        const base = builtinPalette(palette.tone)
        setUserPalettes((list) => list.map((p) => (p.id === palette.id ? { ...clonePalette(base), id: p.id, name: p.name } : p)))
    }, [palette])
    const setQuality = useCallback((patch: Partial<QualitySettings>) => setQualityState((q) => ({ ...q, ...patch })), [])

    return { palettes, palette, select, update, duplicate, remove, resetToBuiltin, quality, setQuality }
}
