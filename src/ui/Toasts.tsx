import { Toast, ToastBody, Toaster, ToastIntent, ToastTitle, useToastController } from "@fluentui/react-components"
import React, { useMemo } from "react"

/** 앱에 하나뿐인 Toaster 의 id. useAppToast 가 같은 id 로 띄운다 */
const APP_TOASTER_ID = "app-toaster"

/**
 * 토스트가 뜨는 자리. App 에 한 번만 둔다. 오른쪽 아래, 데스크톱은 상태 표시줄(28px) 위, 모바일은 탭 막대 위.
 * 오류는 닫을 때까지 남고, 나머지는 5초 뒤 사라진다(useAppToast 참고)
 *
 * @param props.bottom 화면 아래에서 띄울 거리(px)
 */
export const AppToaster = ({ bottom = 40 }: { bottom?: number }) => (
    <Toaster toasterId={APP_TOASTER_ID} position="bottom-end" offset={{ horizontal: 12, vertical: bottom }} />
)

/**
 * 토스트 띄우기. window.alert 를 대체한다.
 *
 * @returns show(intent, 제목, 설명?) 와 success/warning/error 단축
 */
export const useAppToast = () => {
    const { dispatchToast } = useToastController(APP_TOASTER_ID)
    return useMemo(() => {
        const show = (intent: ToastIntent, title: string, body?: string) =>
            dispatchToast(
                <Toast>
                    <ToastTitle>{title}</ToastTitle>
                    {body && <ToastBody>{body}</ToastBody>}
                </Toast>,
                { intent, timeout: intent === "error" ? -1 : 5000 },
            )
        return {
            show,
            success: (title: string, body?: string) => show("success", title, body),
            warning: (title: string, body?: string) => show("warning", title, body),
            error: (title: string, body?: string) => show("error", title, body),
        }
    }, [dispatchToast])
}
