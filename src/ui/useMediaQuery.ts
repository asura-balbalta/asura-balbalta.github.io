import { useEffect, useState } from "react"

/**
 * 미디어 쿼리가 맞는지. 창 크기나 기기 상태가 바뀌면 다시 평가한다.
 *
 * @param query "(max-width: 767px)" 같은 미디어 쿼리
 * @returns 지금 맞으면 true
 */
export const useMediaQuery = (query: string) => {
    const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
    useEffect(() => {
        const mql = window.matchMedia(query)
        const update = () => setMatches(mql.matches)
        update()
        mql.addEventListener("change", update)
        return () => mql.removeEventListener("change", update)
    }, [query])
    return matches
}

/** 모바일 레이아웃(탭 막대·바텀 시트)으로 바꾸는 폭. 설계 문서의 기준(< 768px) */
export const MOBILE_QUERY = "(max-width: 767px)"
