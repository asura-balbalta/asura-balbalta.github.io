/**
 * VWorld 통합 검색(https://api.vworld.kr/req/search). 장소(type=place)와 도로명 주소(type=address, category=road)를 함께
 * 조회해 하나의 목록으로 합친다.
 *
 * VWorld 는 CORS 를 열어 주지 않아 fetch 로는 못 부르고, callback 파라미터를 받는 JSONP 로 부른다: 전역 콜백 함수를 만들고
 * <script src=…> 를 붙이면 서버가 `callback(json)` 을 돌려준다(../app/moda/src/openapi.ts 와 같은 방식). 요청마다 콜백 이름을
 * 새로 만들고, 끝나면 함수와 태그를 지운다. 취소하면 콜백을 빈 함수로 바꿔 늦게 온 응답을 버린다.
 *
 * 응답 모양(2026-10-10 확인): response.status 가 "OK" | "NOT_FOUND" | "ERROR", ERROR 면 response.error.{code,text}
 * (키 만료는 EXPIRE_KEY), OK 면 response.result.items[] 에 place 는 title·address.road·point.{x,y}, address 는
 * address.road·address.parcel·point. crs=EPSG:3857 로 요청하면 point 가 3857 좌표(문자열)로 온다
 */

/** 검색 결과 한 건. coord 는 EPSG:3857 */
export type SearchResult = {
    id: string
    /** 장소 이름 또는 도로명 주소(주소 결과) */
    name: string
    /** 보조 줄: 도로명 주소(장소) 또는 지번 주소(주소) */
    address: string
    coord: [number, number]
}

/** 진행 중인 검색. cancel 하면 promise 는 더 이상 resolve 되지 않는다 */
export type SearchHandle = { promise: Promise<SearchResult[]>; cancel: () => void }

type VworldItem = {
    id?: string
    title?: string
    address?: { road?: string; parcel?: string; bldnm?: string }
    point?: { x: string | number; y: string | number }
}
type VworldResponse = {
    response?: {
        status?: string
        error?: { code?: string; text?: string }
        result?: { items?: VworldItem[] }
    }
}

const JSONP_NS = "__vworldJsonp"
const TIMEOUT_MS = 10_000
let callSeq = 0

/** JSONP 호출 하나. resolve 는 서버가 콜백을 부를 때, reject 는 스크립트 로드 실패·시간 초과 */
const jsonp = (url: string, callbackParam: string): { promise: Promise<VworldResponse>; cancel: () => void } => {
    const w = window as unknown as Record<string, Record<string, (data: VworldResponse) => void>>
    w[JSONP_NS] = w[JSONP_NS] ?? {}
    const id = `cb${Date.now()}_${++callSeq}`
    const script = document.createElement("script")
    let timer = 0
    const cleanup = () => {
        window.clearTimeout(timer)
        delete w[JSONP_NS][id]
        script.remove()
    }
    const promise = new Promise<VworldResponse>((resolve, reject) => {
        w[JSONP_NS][id] = (data) => {
            cleanup()
            resolve(data)
        }
        script.src = `${url}&${callbackParam}=${encodeURIComponent(`${JSONP_NS}.${id}`)}`
        script.async = true
        script.onerror = () => {
            cleanup()
            reject(new Error("검색 서버에 연결하지 못했습니다"))
        }
        timer = window.setTimeout(() => {
            cleanup()
            reject(new Error("검색 응답이 없습니다"))
        }, TIMEOUT_MS)
        document.body.append(script)
    })
    const cancel = () => {
        // 늦게 온 응답은 빈 함수가 받고 버린다. promise 는 영원히 pending(호출 쪽이 결과를 안 쓴다)
        if (w[JSONP_NS][id]) w[JSONP_NS][id] = () => script.remove()
        window.clearTimeout(timer)
    }
    return { promise, cancel }
}

const searchOne = (type: "place" | "address", query: string, key: string) => {
    const params: Record<string, string> = {
        service: "search",
        request: "search",
        version: "2.0",
        crs: "EPSG:3857",
        size: "10",
        page: "1",
        query,
        type,
        format: "json",
        errorformat: "json",
        key,
    }
    if (type === "address") params.category = "road"
    return jsonp(`https://api.vworld.kr/req/search?${new URLSearchParams(params)}`, "callback")
}

/** 응답을 공통 모양으로. NOT_FOUND 는 빈 배열, ERROR 는 예외 */
const normalize = (type: "place" | "address", data: VworldResponse): SearchResult[] => {
    const res = data.response
    if (!res || res.status === "NOT_FOUND") return []
    if (res.status !== "OK") throw new Error(res?.error?.text ?? `검색 실패 (${res?.error?.code ?? res?.status ?? "알 수 없음"})`)
    const out: SearchResult[] = []
    for (const [i, item] of (res.result?.items ?? []).entries()) {
        const x = Number(item.point?.x)
        const y = Number(item.point?.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue
        const road = item.address?.road ?? ""
        const parcel = item.address?.parcel ?? ""
        const name = type === "place" ? (item.title ?? road) : road || parcel
        if (!name) continue
        const address = type === "place" ? road || parcel : parcel
        out.push({ id: `${type}-${item.id ?? i}`, name, address, coord: [x, y] })
    }
    return out
}

/** 끝에 남은 자음·모음 하나("이태ㅇ", 호환 자모 U+3131~U+318E)는 조합 중인 글자라 빼고 검색한다 */
export const trimDanglingJamo = (q: string) => q.replace(/[\u3131-\u318E]+$/, "")

/** 최대 결과 수 */
const MAX_RESULTS = 10

/**
 * 관련성 등급(작을수록 앞). 이름이 검색어와 같음 0, 검색어로 시작 1, 검색어 포함 2, 주소에만 포함 3, 그 밖 4.
 * VWorld 의 순서는 관련성이 아니라 내부 순서라 우리가 다시 정렬한다
 */
const relevance = (r: SearchResult, q: string) => {
    const name = r.name.toLowerCase()
    const query = q.toLowerCase()
    if (name === query) return 0
    if (name.startsWith(query)) return 1
    if (name.includes(query)) return 2
    if (r.address.toLowerCase().includes(query)) return 3
    return 4
}

/**
 * 장소와 주소를 함께 검색한다. 이름+주소가 같은 것은 하나만 남기고, 관련성 등급 → 현재 지도 중심에 가까운 순으로 정렬해
 * MAX_RESULTS 건까지 돌려준다.
 *
 * @param query 검색어(비어 있으면 빈 결과). 끝의 미완성 자모는 뺀다
 * @param key VWorld 인증키(config.ts). 비어 있으면 예외
 * @param near 현재 지도 중심(EPSG:3857). 같은 등급 안에서 가까운 것을 앞에. 없으면 VWorld 순서 유지
 */
export const searchPlaces = (query: string, key: string, near?: [number, number]): SearchHandle => {
    if (!key) {
        return { promise: Promise.reject(new Error("검색 키가 설정되지 않았습니다")), cancel: () => {} }
    }
    const q = trimDanglingJamo(query.trim())
    if (!q) return { promise: Promise.resolve([]), cancel: () => {} }
    const place = searchOne("place", q, key)
    const address = searchOne("address", q, key)
    const promise = Promise.all([place.promise, address.promise]).then(([p, a]) => {
        const merged = [...normalize("place", p), ...normalize("address", a)]
        const seen = new Set<string>()
        const unique = merged.filter((r) => {
            const k = `${r.name}|${r.address}`
            if (seen.has(k)) return false
            seen.add(k)
            return true
        })
        const dist = (r: SearchResult) => (near ? Math.hypot(r.coord[0] - near[0], r.coord[1] - near[1]) : 0)
        // sort 는 안정 정렬이라 등급·거리가 같으면 VWorld 순서(장소 → 주소)가 유지된다
        return unique
            .map((r, i) => ({ r, grade: relevance(r, q), d: dist(r), i }))
            .sort((x, y) => x.grade - y.grade || x.d - y.d || x.i - y.i)
            .slice(0, MAX_RESULTS)
            .map((x) => x.r)
    })
    return {
        promise,
        cancel: () => {
            place.cancel()
            address.cancel()
        },
    }
}
