import { ProgressBar } from "@fluentui/react-components"
import { DismissRegular, LocationRegular, SearchRegular } from "@fluentui/react-icons"
import React, { useEffect, useRef, useState } from "react"

import type { SearchResult } from "../vworld"

/** 검색 진행 상태(app 이 들고 있다) */
export type SearchStatus =
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "done"; results: SearchResult[] }
    | { kind: "error"; message: string }

/** 입력 중인 요소(input·textarea·contenteditable)에서는 "/" 단축키를 가로채지 않는다 */
const isEditable = (target: EventTarget | null) => {
    const el = target as HTMLElement | null
    if (!el) return false
    return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable
}

/** 검색어가 들어 있는 부분을 굵게 */
const Highlight = ({ text, query }: { text: string; query: string }) => {
    const q = query.trim()
    const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1
    if (i < 0) return <>{text}</>
    return (
        <>
            {text.slice(0, i)}
            <b>{text.slice(i, i + q.length)}</b>
            {text.slice(i + q.length)}
        </>
    )
}

/**
 * 주소 검색 알약(위 가운데 유리)과 그 아래 결과 패널(화면 시안 "주소 검색"). 지도 화면에서만 쓴다.
 *
 * 패널은 입력란에 포커스가 있는 동안 열린다. 검색어가 비어 있으면 "현재 위치로 이동" 과 입력 안내, 검색 중이면 진행 막대,
 * 결과가 없으면 안내 문구, 있으면 행(이름 + 주소). ↑↓ 로 행을 고르고 Enter 로 선택, Esc 는 검색어가 있으면 지우고 없으면
 * 닫는다. 입력 중이 아닐 때 "/" 를 누르면 입력란으로 포커스. 행은 pointerdown 에서 preventDefault 해 입력란의 포커스를
 * 유지한 채 클릭된다. 모양은 ui.css(.ui-search, .ui-search-panel)
 *
 * @param props.query 입력란의 글자(app 상태). 선택하면 app 이 선택한 이름으로 바꾼다
 * @param props.onQueryChange 글자가 바뀔 때
 * @param props.status 검색 진행 상태
 * @param props.onSelect 결과 행을 골랐을 때
 * @param props.onLocate "현재 위치로 이동" 을 골랐을 때
 * @param props.onClear 지우기(×) 또는 Esc 로 검색어를 비울 때
 */
export const SearchBox = ({
    query,
    onQueryChange,
    status,
    onSelect,
    onLocate,
    onClear,
}: {
    query: string
    onQueryChange: (query: string) => void
    status: SearchStatus
    onSelect: (result: SearchResult) => void
    onLocate: () => void
    onClear: () => void
}) => {
    const inputRef = useRef<HTMLInputElement | null>(null)
    const [open, setOpen] = useState(false)
    /** 키보드로 고른 행의 번호(검색어가 비어 있으면 0 = 현재 위치) */
    const [active, setActive] = useState(0)
    const results = status.kind === "done" ? status.results : []
    const empty = query.trim() === ""
    const rowCount = empty ? 1 : results.length

    useEffect(() => setActive(0), [query, status])

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isEditable(e.target)) {
                e.preventDefault()
                inputRef.current?.focus()
            }
        }
        document.addEventListener("keydown", onKey)
        return () => document.removeEventListener("keydown", onKey)
    }, [])

    const choose = (index: number) => {
        if (empty) {
            onLocate()
        } else {
            const r = results[index]
            if (r) onSelect(r)
        }
        inputRef.current?.blur()
    }

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        // 한글 조합 중의 Enter·↑↓ 는 입력기가 글자를 확정하는 데 쓰는 키다. 선택으로 받지 않는다
        if (e.nativeEvent.isComposing) return
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            if (rowCount === 0) return
            e.preventDefault()
            setActive((prev) => (prev + (e.key === "ArrowDown" ? 1 : rowCount - 1)) % rowCount)
        } else if (e.key === "Enter") {
            if (rowCount === 0) return
            e.preventDefault()
            choose(active)
        } else if (e.key === "Escape") {
            e.preventDefault()
            if (query) onClear()
            else inputRef.current?.blur()
        }
    }

    const keepFocus = (e: React.PointerEvent) => e.preventDefault()

    return (
        <>
            <div className={open ? "ui-search ui-glass ui-search-focused" : "ui-search ui-glass"}>
                <SearchRegular fontSize={16} />
                <input
                    ref={inputRef}
                    className="ui-search-input"
                    type="text"
                    value={query}
                    placeholder="주소나 장소 검색"
                    aria-label="주소나 장소 검색"
                    role="combobox"
                    aria-expanded={open}
                    aria-controls="search-results"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => onQueryChange(e.target.value)}
                    onFocus={() => setOpen(true)}
                    onBlur={() => setOpen(false)}
                    onKeyDown={onKeyDown}
                />
                {query ? (
                    <button
                        type="button"
                        className="ui-search-clear"
                        aria-label="검색어 지우기"
                        onPointerDown={keepFocus}
                        onClick={() => {
                            onClear()
                            inputRef.current?.focus()
                        }}
                    >
                        <DismissRegular fontSize={12} />
                    </button>
                ) : (
                    <span className="ui-search-key" aria-hidden="true">
                        {open ? "Esc" : "/"}
                    </span>
                )}
            </div>
            {open && (
                <div id="search-results" className="ui-panel ui-search-panel" role="listbox" onPointerDown={keepFocus}>
                    {status.kind === "error" ? (
                        <div className="ui-search-note">
                            <div className="ui-search-note-strong">{status.message}</div>
                        </div>
                    ) : empty ? (
                        <>
                            <button
                                type="button"
                                role="option"
                                aria-selected={active === 0}
                                className={active === 0 ? "ui-search-row ui-search-row-active" : "ui-search-row"}
                                onClick={() => choose(0)}
                            >
                                <LocationRegular fontSize={16} className="ui-search-row-icon" />
                                <span className="ui-search-row-text">
                                    <span className="ui-search-row-name">현재 위치로 이동</span>
                                    <span className="ui-search-row-addr">브라우저 위치 정보를 씁니다</span>
                                </span>
                            </button>
                            <div className="ui-search-note">
                                도로명 주소나 장소 이름을 입력하세요.
                                <br />예: 이태원로 177, 서울역
                            </div>
                        </>
                    ) : status.kind === "loading" || status.kind === "idle" ? (
                        <div className="ui-search-loading">
                            <span className="ui-statusbar-dot" />
                            검색 중
                            <ProgressBar className="ui-search-progress" thickness="medium" aria-label="검색 중" />
                        </div>
                    ) : results.length === 0 ? (
                        <div className="ui-search-note">
                            <div className="ui-search-note-strong">"{query.trim()}" 에 맞는 결과가 없습니다.</div>
                            도로명 주소나 장소 이름으로 다시 검색해 보세요.
                        </div>
                    ) : (
                        results.map((r, i) => (
                            <button
                                key={r.id}
                                type="button"
                                role="option"
                                aria-selected={active === i}
                                className={active === i ? "ui-search-row ui-search-row-active" : "ui-search-row"}
                                onClick={() => choose(i)}
                            >
                                <span className="ui-search-row-text">
                                    <span className="ui-search-row-name">
                                        <Highlight text={r.name} query={query} />
                                    </span>
                                    {r.address && <span className="ui-search-row-addr">{r.address}</span>}
                                </span>
                            </button>
                        ))
                    )}
                    <div className="ui-search-foot">↑↓ 이동 · Enter 선택 · Esc 닫기</div>
                </div>
            )}
        </>
    )
}
