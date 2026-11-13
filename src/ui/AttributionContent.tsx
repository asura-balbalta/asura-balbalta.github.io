import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle } from "@fluentui/react-components"
import React, { useEffect, useState } from "react"

import {
    AS_IS_LAYERS,
    Attribution,
    ATTRIBUTION_TXT_URL,
    AttributionSource,
    CC_BY_URL,
    fetchAttribution,
    fetchLayerAttribution,
    KOGL_URL,
    LayerAttribution,
    NON_PUBLIC_LAYERS,
} from "../attribution"
import { LAYER_DEFS, LayerId } from "../layers"

/** 자료 하나의 표시문 블록(이름 · 제공기관 · 기준일 · 포털 링크 · 라이선스 링크 · 가공) */
const SourceItem = ({ s }: { s: AttributionSource }) => (
    <li className="ui-attribution-item">
        <div className="ui-attribution-name">{s.name}</div>
        <div>
            {s.provider}
            {s.asof && ` (${s.asof} 기준)`}
            {s.portal && (
                <>
                    {", "}
                    {s.url ? (
                        <a href={s.url} target="_blank" rel="noreferrer">
                            {s.portal}
                        </a>
                    ) : (
                        s.portal
                    )}
                </>
            )}
            {!s.portal && s.url && (
                <>
                    {", "}
                    <a href={s.url} target="_blank" rel="noreferrer">
                        원자료
                    </a>
                </>
            )}
        </div>
        <div className="ui-attribution-license">
            {s.license_url ? (
                <a href={s.license_url} target="_blank" rel="noreferrer">
                    {s.license}
                </a>
            ) : (
                s.license
            )}
            {s.processing && ` · ${s.processing_label ?? "가공"}: ${s.processing}`}
        </div>
        {s.license_note && <div className="ui-attribution-note">{s.license_note}</div>}
    </li>
)

/** 잘 알려진 라이선스 주소의 짧은 이름(전부터 링크 줄에 쓰던 것). 나머지는 license 에서 괄호 풀이를 뺀 이름 */
const LICENSE_LINK_LABELS: Record<string, string> = { [KOGL_URL]: "공공누리 제1유형", [CC_BY_URL]: "CC BY 4.0" }

/**
 * 라이선스 링크 줄의 항목(2026-11-08 G6: 공공누리·CC BY 고정에서 원자료의 license_url 로 일반화해 녹지의 ODbL 이 나오게).
 * 원자료 순서대로 주소마다 한 번. license_url 이 원자료 주소와 같은 사이트(자료 안내 페이지, 예: 산림·건축물대장)면 라이선스
 * 문서가 아니므로 뺀다(원자료 링크와 겹침). "제공 방식" 원자료(AS_IS_LAYERS, 산림)도 뺀다(전처럼 링크 줄에 싣지 않음)
 */
const licenseLinks = (sources: AttributionSource[]) => {
    const host = (u?: string) => {
        try {
            return u ? new URL(u).host : ""
        } catch {
            return ""
        }
    }
    const links: { url: string; label: string }[] = []
    for (const s of sources) {
        const url = s.license_url
        if (!url || s.processing_label === "제공 방식" || host(url) === host(s.url)) continue
        if (links.some((l) => l.url === url)) continue
        links.push({ url, label: LICENSE_LINK_LABELS[url] ?? s.license.replace(/\s*\(.*\)\s*$/, "") })
    }
    return links
}

/**
 * 출처 표시문(src/attribution.ts 머리말). 통합 창(AttributionDialog)과 페이지(#/attribution, AttributionPage)가 같이 쓴다.
 * layer 를 주면(레이어 패널 "출처보기") 그 레이어의 인덱스만 받아 그 자료만 그리고, 검색·바탕 지도 항목은 뺀다. 라이선스 링크 줄
 * (원자료의 license_url, licenseLinks)과 면책은 둘 다 둔다. 단 원자료를 고치지 않고 쓰는 레이어(AS_IS_LAYERS, 산림)의 창은 "가공하여" 문구·링크 줄·면책을 뺀다.
 * 받는 동안은 "불러오는 중", 받으면 그린다. 모양은 ui.css(.ui-attribution)
 *
 * @param props.layer 이 레이어의 출처만. 없으면 전부
 */
export const AttributionContent = ({ layer }: { layer?: LayerId }) => {
    const [data, setData] = useState<(LayerAttribution & { extras?: AttributionSource[] }) | null>(null)
    useEffect(() => {
        let alive = true
        setData(null)
        const p: Promise<LayerAttribution | Attribution> = layer ? fetchLayerAttribution(layer) : fetchAttribution()
        p.then((a) => alive && setData(a))
        return () => void (alive = false)
    }, [layer])
    if (!data) return <div className="ui-attribution">불러오는 중…</div>
    const label = layer && LAYER_DEFS.find((d) => d.id === layer)?.label
    const asIs = !!layer && AS_IS_LAYERS.has(layer)
    const publicData = !layer || !NON_PUBLIC_LAYERS.has(layer)
    const links = licenseLinks(data.sources)
    return (
        <div className="ui-attribution">
            <p>
                {label
                    ? `이 서비스의 ${label} 데이터는 아래 ${publicData ? "공공데이터" : "자료"}를 ${asIs ? "" : "가공하여 "}사용합니다.`
                    : "이 서비스의 지형·건물·녹지 데이터는 아래 공공데이터와 OpenStreetMap 자료를 가공하여 사용합니다."}
            </p>
            <ul>
                {data.sources.map((s) => (
                    <SourceItem key={s.name} s={s} />
                ))}
            </ul>
            {data.extras && (
                <>
                    <p className="ui-attribution-sub">지도 검색과 바탕 지도</p>
                    <ul>
                        {data.extras.map((s) => (
                            <SourceItem key={s.name} s={s} />
                        ))}
                    </ul>
                </>
            )}
            {!asIs && (
                <p className="ui-attribution-links">
                    {links.map((l) => (
                        <React.Fragment key={l.url}>
                            <a href={l.url} target="_blank" rel="noreferrer">
                                {l.label}
                            </a>
                            {" · "}
                        </React.Fragment>
                    ))}
                    <a href={ATTRIBUTION_TXT_URL} target="_blank" rel="noreferrer">
                        데이터 서버의 표시문(ATTRIBUTION.txt)
                    </a>
                </p>
            )}
            {!asIs && <p className="ui-attribution-disclaimer">{data.disclaimer}</p>}
            {!data.fromServer && <p className="ui-attribution-note">서버의 최신 표시문을 받지 못해 내장 문구를 보여 줍니다.</p>}
        </div>
    )
}

/**
 * 앱 안의 출처 창(Fluent Dialog). 상태 표시줄 한 줄·모바일 한 줄·설정·내보내기 꼬리말의 "원본 데이터 출처" 에서 통합으로,
 * 레이어 패널의 "출처보기" 에서 레이어 하나로 연다. 페이지로 가면 App 이 내려가 받아 둔 지형을 잃으므로 앱 안에서는 창으로
 * 보이고, 페이지(#/attribution)는 새 탭용이다
 *
 * @param props.open 열려 있는지
 * @param props.layer 이 레이어의 출처만(제목에 레이어 이름이 붙는다). 없으면 전부
 * @param props.onClose 닫기(닫기 버튼·바깥 클릭·Esc)
 */
export const AttributionDialog = ({ open, layer, onClose }: { open: boolean; layer?: LayerId; onClose: () => void }) => (
    <Dialog open={open} onOpenChange={(_, data) => !data.open && onClose()}>
        <DialogSurface className="ui-attribution-dialog">
            <DialogBody>
                <DialogTitle>
                    원본 데이터 출처{layer && ` · ${LAYER_DEFS.find((d) => d.id === layer)?.label ?? layer}`}
                </DialogTitle>
                <DialogContent>
                    <AttributionContent layer={layer} />
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
