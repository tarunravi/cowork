import { Redirect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Button, Image, Text, TextInput, View } from "react-native";
import { api, type ControlState, type Screenshot } from "../src/api";
import { authClient, serverUrl } from "../src/auth";
import { colors, input, muted, Problem, Screen, useAction } from "../src/ui";

type Frame = { uri: string; width: number; height: number };

const path = (botId: string, rest: string) =>
  `/api/computers/${encodeURIComponent(botId)}${rest}`;

/**
 * The live screen: frames from the same authenticated stream the web view uses, with a screenshot
 * poll until the stream delivers (or when it cannot connect).
 */
function useLiveFrame(botId: string, enabled: boolean) {
  const [frame, setFrame] = useState<Frame>();
  const [problem, setProblem] = useState("");
  const streaming = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    let closed = false;
    let socket: WebSocket | undefined;
    streaming.current = false;
    void (async () => {
      const cookie = await authClient.getCookie();
      if (closed) return;
      const url = `${serverUrl.replace(/^http/, "ws")}${path(botId, "/stream")}`;
      // React Native's WebSocket accepts headers, which is how the session cookie reaches the upgrade.
      const Native = WebSocket as unknown as new (
        url: string,
        protocols: string[] | null,
        options: { headers: Record<string, string> },
      ) => WebSocket;
      socket = new Native(url, null, {
        headers: cookie ? { Cookie: cookie } : {},
      });
      socket.onmessage = (event) => {
        let message: unknown;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (!message || typeof message !== "object") return;
        const value = message as {
          type?: unknown;
          data?: unknown;
          width?: unknown;
          height?: unknown;
          error?: unknown;
        };
        if (value.type === "error" && typeof value.error === "string") {
          setProblem(value.error);
          return;
        }
        if (value.type !== "frame" || typeof value.data !== "string") return;
        const width = typeof value.width === "number" ? value.width : 1280;
        const height = typeof value.height === "number" ? value.height : 800;
        if (!(width > 0 && height > 0 && width <= 8192 && height <= 8192))
          return;
        streaming.current = true;
        setFrame({
          uri: `data:image/jpeg;base64,${value.data}`,
          width,
          height,
        });
      };
      socket.onclose = () => {
        streaming.current = false;
      };
    })();
    // Until frames stream, and whenever they stop, show the latest screenshot instead.
    const poll = setInterval(async () => {
      if (streaming.current || AppState.currentState !== "active") return;
      try {
        const shot = await api<Screenshot | { frame: Screenshot }>(
          path(botId, "/screenshot"),
        );
        const value = "frame" in shot ? shot.frame : shot;
        if (closed || streaming.current || !value?.base64) return;
        setFrame({
          uri: `data:image/png;base64,${value.base64}`,
          width: value.width,
          height: value.height,
        });
        setProblem("");
      } catch (failure) {
        setProblem(
          failure instanceof Error
            ? failure.message
            : "The screen is not available right now.",
        );
      }
    }, 1500);
    return () => {
      closed = true;
      clearInterval(poll);
      socket?.close();
    };
  }, [botId, enabled]);
  return { frame, problem };
}

/**
 * A read-only viewer. Explicit ownership handoff pauses the Bot without enabling gestures.
 */
export default function ComputerScreen() {
  const { botId = "" } = useLocalSearchParams<{ botId: string }>();
  const { data: session, isPending } = authClient.useSession();
  const action = useAction();
  const [control, setControl] = useState<
    (ControlState & { canControl?: boolean }) | null
  >(null);
  const [requestId, setRequestId] = useState("");
  const takenRequestId = useRef("");
  const [secret, setSecret] = useState("");
  const live = useLiveFrame(botId, Boolean(session && botId));
  const driving = control?.holder === "human" && !control.transitioning;

  const readControl = useCallback(async () => {
    const state = await api<ControlState & { canControl?: boolean }>(
      path(
        botId,
        `/control${requestId ? `?requestId=${encodeURIComponent(requestId)}` : ""}`,
      ),
    );
    setControl(state);
    return state;
  }, [botId, requestId]);

  const take = useCallback(
    () =>
      action.run("take", async () => {
        const current = await readControl();
        if (!current.canControl) return;
        const waiting =
          current.request?.status === "waiting" ? current.request.id : "";
        const id =
          waiting ||
          (
            await api<ControlState>(path(botId, "/control/request"), {
              method: "POST",
              body: { reason: "Opened on mobile." },
            })
          ).request?.id;
        if (!id) throw new Error("Control could not be requested.");
        setRequestId(id);
        await api<ControlState>(path(botId, "/control/take"), {
          method: "POST",
          body: { requestId: id },
        });
        takenRequestId.current = id;
        await readControl();
      }),
    [action, botId, readControl],
  );

  useEffect(() => {
    if (!session || !botId) return;
    void readControl().catch(() => undefined);
    const timer = setInterval(() => {
      if (AppState.currentState === "active")
        void readControl().catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [session, botId, readControl]);

  // Only return control on exit when this visit successfully took it.
  const release = useRef<() => void>(() => {});
  release.current = () => {
    if (takenRequestId.current && control?.holder === "human")
      void api(path(botId, "/control/release"), {
        method: "POST",
        body: { requestId: takenRequestId.current },
      }).catch(() => undefined);
  };
  useEffect(() => () => release.current(), []);

  if (!session && !isPending) return <Redirect href="/" />;

  const frame = live.frame;

  return (
    <Screen>
      <View
        style={{
          padding: 12,
          borderRadius: 8,
          backgroundColor: driving ? "#ecfdf3" : "#f3f4f6",
          gap: 4,
        }}
      >
        <Text style={{ fontWeight: "600" }}>
          {!control
            ? "Checking who has control…"
            : control.transitioning
              ? "Finishing the Bot's current action before giving you control…"
              : driving
                ? "You have control. The screen is read-only."
                : "The Bot has control. The screen is read-only."}
        </Text>
        {control?.reason ? <Text style={muted}>{control.reason}</Text> : null}
      </View>
      <Problem message={action.error || live.problem} />
      {control?.secretWanted ? (
        <View style={{ gap: 8 }}>
          <Text>{control.secretWanted}</Text>
          <TextInput
            accessibilityLabel="Secret value"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            value={secret}
            onChangeText={setSecret}
            style={input}
          />
          <Button
            title="Enter it for the Bot"
            disabled={!secret || Boolean(action.busy)}
            onPress={() => {
              void action
                .run("secret", () =>
                  api(path(botId, "/human/secret"), {
                    method: "POST",
                    body: { text: secret },
                  }),
                )
                // Never kept after it is sent, whether or not it was accepted.
                .finally(() => setSecret(""));
            }}
          />
        </View>
      ) : null}
      <View
        accessibilityLabel="Bot computer screen"
        style={{
          width: "100%",
          aspectRatio: frame ? frame.width / frame.height : 16 / 10,
          backgroundColor: "#111827",
          borderRadius: 6,
          overflow: "hidden",
          borderWidth: driving ? 2 : 0,
          borderColor: colors.success,
        }}
      >
        {frame ? (
          <Image
            source={{ uri: frame.uri }}
            resizeMode="contain"
            style={{ width: "100%", height: "100%" }}
          />
        ) : (
          <Text style={{ color: "white", padding: 16 }}>
            Connecting to the screen…
          </Text>
        )}
      </View>
      {driving ? (
        <View style={{ gap: 10 }}>
          <Button
            title="Return control to the Bot"
            disabled={Boolean(action.busy)}
            onPress={() => {
              void action.run("release", async () => {
                await api<ControlState>(path(botId, "/control/release"), {
                  method: "POST",
                  body: { requestId: control?.request?.id || requestId },
                });
                takenRequestId.current = "";
                await readControl();
              });
            }}
          />
        </View>
      ) : control?.canControl ? (
        <Button
          title="Take control"
          disabled={Boolean(action.busy) || control?.transitioning}
          onPress={() => {
            void take();
          }}
        />
      ) : control ? (
        <Text style={muted}>Computer handoff is unavailable for this Bot.</Text>
      ) : null}
    </Screen>
  );
}
