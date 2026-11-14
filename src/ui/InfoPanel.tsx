import { OpenRegular } from "@fluentui/react-icons"
import React from "react"

/**
 * 소개: 공개 저장소 GitHub Pages 의 readme.html. 루트(https://asura-balbalta.github.io/)는 Actions 배포 뒤로 앱 자체라
 * 소개가 아니다(2026-11-14. github.io 배포본에서 누르면 같은 앱이 또 열림)
 */
const INTRO_URL = "https://asura-balbalta.github.io/readme.html"
/** GitHub: 공개 저장소(fb_web 커밋을 재현해 올리는 곳. docs/opensource-release-plan.md) */
const REPO_URL = "https://github.com/asura-balbalta/asura-balbalta.github.io"

const LINKS: { label: string; url: string }[] = [
    { label: "소개", url: INTRO_URL },
    { label: "GitHub", url: REPO_URL },
]

/**
 * 정보 패널(독·탭 막대의 설정 오른쪽): 소개 페이지와 공개 저장소로 가는 두 줄. 둘 다 새 탭으로 연다.
 * 행 모양은 패널 공통 .ui-row(32px, 호버 바탕), 링크 글자색·밑줄 해제는 ui.css(.ui-info-row)
 */
export const InfoPanel = () => (
    <>
        {LINKS.map(({ label, url }) => (
            <a key={url} className="ui-row ui-info-row" href={url} target="_blank" rel="noopener noreferrer">
                <span>{label}</span>
                <OpenRegular aria-hidden />
            </a>
        ))}
    </>
)
