import { z } from 'zod';
export declare const TranscriptWordSchema: z.ZodObject<{
    word: z.ZodString;
    start: z.ZodNumber;
    end: z.ZodNumber;
}, z.core.$strip>;
export declare const TranscriptSchema: z.ZodObject<{
    version: z.ZodDefault<z.ZodLiteral<1>>;
    language: z.ZodOptional<z.ZodString>;
    text: z.ZodString;
    durationSeconds: z.ZodOptional<z.ZodNumber>;
    words: z.ZodDefault<z.ZodArray<z.ZodObject<{
        word: z.ZodString;
        start: z.ZodNumber;
        end: z.ZodNumber;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export declare const EasingSchema: z.ZodEnum<{
    "ease-in": "ease-in";
    "ease-in-out": "ease-in-out";
    "ease-out": "ease-out";
    linear: "linear";
    spring: "spring";
}>;
export declare const AnchorSchema: z.ZodEnum<{
    "bottom-center": "bottom-center";
    "bottom-left": "bottom-left";
    "bottom-right": "bottom-right";
    center: "center";
    "center-left": "center-left";
    "center-right": "center-right";
    "top-center": "top-center";
    "top-left": "top-left";
    "top-right": "top-right";
}>;
export declare const COLOR_PATTERN = "^(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|palette:[a-zA-Z0-9_-]+)$";
export declare const ColorSchema: z.ZodString;
export declare const TransitionSchema: z.ZodObject<{
    style: z.ZodString;
    duration: z.ZodDefault<z.ZodNumber>;
    easing: z.ZodDefault<z.ZodEnum<{
        "ease-in": "ease-in";
        "ease-in-out": "ease-in-out";
        "ease-out": "ease-out";
        linear: "linear";
        spring: "spring";
    }>>;
}, z.core.$strip>;
export declare const BackgroundSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"color">;
    color: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"gradient">;
    from: z.ZodString;
    to: z.ZodString;
    angle: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"image">;
    assetId: z.ZodString;
    fit: z.ZodDefault<z.ZodEnum<{
        contain: "contain";
        cover: "cover";
    }>>;
}, z.core.$strip>], "type">;
export declare const ThemeSchema: z.ZodObject<{
    background: z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"color">;
        color: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"gradient">;
        from: z.ZodString;
        to: z.ZodString;
        angle: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        assetId: z.ZodString;
        fit: z.ZodDefault<z.ZodEnum<{
            contain: "contain";
            cover: "cover";
        }>>;
    }, z.core.$strip>], "type">;
    palette: z.ZodRecord<z.ZodString, z.ZodString>;
    fontFamily: z.ZodDefault<z.ZodString>;
    speed: z.ZodDefault<z.ZodNumber>;
    defaultEasing: z.ZodDefault<z.ZodEnum<{
        "ease-in": "ease-in";
        "ease-in-out": "ease-in-out";
        "ease-out": "ease-out";
        linear: "linear";
        spring: "spring";
    }>>;
}, z.core.$strip>;
export declare const PositionSchema: z.ZodObject<{
    anchor: z.ZodDefault<z.ZodEnum<{
        "bottom-center": "bottom-center";
        "bottom-left": "bottom-left";
        "bottom-right": "bottom-right";
        center: "center";
        "center-left": "center-left";
        "center-right": "center-right";
        "top-center": "top-center";
        "top-left": "top-left";
        "top-right": "top-right";
    }>>;
    offsetX: z.ZodDefault<z.ZodNumber>;
    offsetY: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export declare const SceneSchema: z.ZodObject<{
    id: z.ZodString;
    component: z.ZodString;
    at: z.ZodNumber;
    duration: z.ZodNumber;
    position: z.ZodDefault<z.ZodObject<{
        anchor: z.ZodDefault<z.ZodEnum<{
            "bottom-center": "bottom-center";
            "bottom-left": "bottom-left";
            "bottom-right": "bottom-right";
            center: "center";
            "center-left": "center-left";
            "center-right": "center-right";
            "top-center": "top-center";
            "top-left": "top-left";
            "top-right": "top-right";
        }>>;
        offsetX: z.ZodDefault<z.ZodNumber>;
        offsetY: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    props: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    color: z.ZodOptional<z.ZodString>;
    enter: z.ZodObject<{
        style: z.ZodString;
        duration: z.ZodDefault<z.ZodNumber>;
        easing: z.ZodDefault<z.ZodEnum<{
            "ease-in": "ease-in";
            "ease-in-out": "ease-in-out";
            "ease-out": "ease-out";
            linear: "linear";
            spring: "spring";
        }>>;
    }, z.core.$strip>;
    exit: z.ZodOptional<z.ZodObject<{
        style: z.ZodString;
        duration: z.ZodDefault<z.ZodNumber>;
        easing: z.ZodDefault<z.ZodEnum<{
            "ease-in": "ease-in";
            "ease-in-out": "ease-in-out";
            "ease-out": "ease-out";
            linear: "linear";
            spring: "spring";
        }>>;
    }, z.core.$strip>>;
    trigger: z.ZodOptional<z.ZodObject<{
        word: z.ZodString;
        occurrence: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const MetaSchema: z.ZodObject<{
    fps: z.ZodDefault<z.ZodNumber>;
    width: z.ZodDefault<z.ZodNumber>;
    height: z.ZodDefault<z.ZodNumber>;
    durationInSeconds: z.ZodNumber;
}, z.core.$strip>;
export declare const SideVideoSchema: z.ZodObject<{
    assetId: z.ZodString;
    position: z.ZodDefault<z.ZodObject<{
        anchor: z.ZodDefault<z.ZodEnum<{
            "bottom-center": "bottom-center";
            "bottom-left": "bottom-left";
            "bottom-right": "bottom-right";
            center: "center";
            "center-left": "center-left";
            "center-right": "center-right";
            "top-center": "top-center";
            "top-left": "top-left";
            "top-right": "top-right";
        }>>;
        offsetX: z.ZodDefault<z.ZodNumber>;
        offsetY: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    sizePercent: z.ZodDefault<z.ZodNumber>;
    shape: z.ZodDefault<z.ZodEnum<{
        circle: "circle";
        rounded: "rounded";
        square: "square";
    }>>;
}, z.core.$strip>;
export declare const VideoSpecSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    meta: z.ZodObject<{
        fps: z.ZodDefault<z.ZodNumber>;
        width: z.ZodDefault<z.ZodNumber>;
        height: z.ZodDefault<z.ZodNumber>;
        durationInSeconds: z.ZodNumber;
    }, z.core.$strip>;
    theme: z.ZodObject<{
        background: z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"color">;
            color: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"gradient">;
            from: z.ZodString;
            to: z.ZodString;
            angle: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"image">;
            assetId: z.ZodString;
            fit: z.ZodDefault<z.ZodEnum<{
                contain: "contain";
                cover: "cover";
            }>>;
        }, z.core.$strip>], "type">;
        palette: z.ZodRecord<z.ZodString, z.ZodString>;
        fontFamily: z.ZodDefault<z.ZodString>;
        speed: z.ZodDefault<z.ZodNumber>;
        defaultEasing: z.ZodDefault<z.ZodEnum<{
            "ease-in": "ease-in";
            "ease-in-out": "ease-in-out";
            "ease-out": "ease-out";
            linear: "linear";
            spring: "spring";
        }>>;
    }, z.core.$strip>;
    audioAssetId: z.ZodOptional<z.ZodString>;
    sideVideo: z.ZodOptional<z.ZodObject<{
        assetId: z.ZodString;
        position: z.ZodDefault<z.ZodObject<{
            anchor: z.ZodDefault<z.ZodEnum<{
                "bottom-center": "bottom-center";
                "bottom-left": "bottom-left";
                "bottom-right": "bottom-right";
                center: "center";
                "center-left": "center-left";
                "center-right": "center-right";
                "top-center": "top-center";
                "top-left": "top-left";
                "top-right": "top-right";
            }>>;
            offsetX: z.ZodDefault<z.ZodNumber>;
            offsetY: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
        sizePercent: z.ZodDefault<z.ZodNumber>;
        shape: z.ZodDefault<z.ZodEnum<{
            circle: "circle";
            rounded: "rounded";
            square: "square";
        }>>;
    }, z.core.$strip>>;
    scenes: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        component: z.ZodString;
        at: z.ZodNumber;
        duration: z.ZodNumber;
        position: z.ZodDefault<z.ZodObject<{
            anchor: z.ZodDefault<z.ZodEnum<{
                "bottom-center": "bottom-center";
                "bottom-left": "bottom-left";
                "bottom-right": "bottom-right";
                center: "center";
                "center-left": "center-left";
                "center-right": "center-right";
                "top-center": "top-center";
                "top-left": "top-left";
                "top-right": "top-right";
            }>>;
            offsetX: z.ZodDefault<z.ZodNumber>;
            offsetY: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
        props: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        color: z.ZodOptional<z.ZodString>;
        enter: z.ZodObject<{
            style: z.ZodString;
            duration: z.ZodDefault<z.ZodNumber>;
            easing: z.ZodDefault<z.ZodEnum<{
                "ease-in": "ease-in";
                "ease-in-out": "ease-in-out";
                "ease-out": "ease-out";
                linear: "linear";
                spring: "spring";
            }>>;
        }, z.core.$strip>;
        exit: z.ZodOptional<z.ZodObject<{
            style: z.ZodString;
            duration: z.ZodDefault<z.ZodNumber>;
            easing: z.ZodDefault<z.ZodEnum<{
                "ease-in": "ease-in";
                "ease-in-out": "ease-in-out";
                "ease-out": "ease-out";
                linear: "linear";
                spring: "spring";
            }>>;
        }, z.core.$strip>>;
        trigger: z.ZodOptional<z.ZodObject<{
            word: z.ZodString;
            occurrence: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type Easing = z.infer<typeof EasingSchema>;
export type TranscriptWord = z.infer<typeof TranscriptWordSchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;
export type Anchor = z.infer<typeof AnchorSchema>;
export type Color = z.infer<typeof ColorSchema>;
export type Transition = z.infer<typeof TransitionSchema>;
export type Background = z.infer<typeof BackgroundSchema>;
export type Theme = z.infer<typeof ThemeSchema>;
export type Position = z.infer<typeof PositionSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type Meta = z.infer<typeof MetaSchema>;
export type SideVideo = z.infer<typeof SideVideoSchema>;
export type VideoSpec = z.infer<typeof VideoSpecSchema>;
export declare const defaultSpec: () => VideoSpec;
