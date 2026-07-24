import * as DelegationBytecodes from "@metamask/delegation-abis/bytecode";
import {
    getAddress,
    isHex,
    keccak256,
    stringToHex,
    type Address,
    type Hex,
} from "viem";
import {ENTRY_POINT_V07} from "./network.js";

export const FRAMEWORK_DEPLOYMENT_COUNT = 38 as const;

export const FRAMEWORK_DEPLOYMENT_ORDER = [
    "SimpleFactory",
    "AllowedCalldataEnforcer",
    "AllowedTargetsEnforcer",
    "AllowedMethodsEnforcer",
    "ApprovalRevocationEnforcer",
    "ArgsEqualityCheckEnforcer",
    "DeployedEnforcer",
    "TimestampEnforcer",
    "BlockNumberEnforcer",
    "LimitedCallsEnforcer",
    "ERC20BalanceChangeEnforcer",
    "ERC20TransferAmountEnforcer",
    "ERC20StreamingEnforcer",
    "ERC721BalanceChangeEnforcer",
    "ERC721TransferEnforcer",
    "ERC1155BalanceChangeEnforcer",
    "IdEnforcer",
    "NonceEnforcer",
    "ValueLteEnforcer",
    "NativeTokenTransferAmountEnforcer",
    "NativeBalanceChangeEnforcer",
    "NativeTokenStreamingEnforcer",
    "OwnershipTransferEnforcer",
    "RedeemerEnforcer",
    "SpecificActionERC20TransferBatchEnforcer",
    "ERC20PeriodTransferEnforcer",
    "NativeTokenPeriodTransferEnforcer",
    "ExactCalldataBatchEnforcer",
    "ExactCalldataEnforcer",
    "ExactExecutionEnforcer",
    "ExactExecutionBatchEnforcer",
    "MultiTokenPeriodEnforcer",
    "DelegationManager",
    "NativeTokenPaymentEnforcer",
    "SCL_RIP7212",
    "HybridDeleGatorImpl",
    "MultiSigDeleGatorImpl",
    "EIP7702StatelessDeleGatorImpl",
] as const;

export type FrameworkDeploymentName = (typeof FRAMEWORK_DEPLOYMENT_ORDER)[number];

export interface ByteRange {
    start: number;
    length: number;
}

interface ExactRuntimeVerification {
    kind: "exact";
    codeHash: Hex;
}

interface NormalizedRuntimeVerification {
    kind: "normalized";
    normalizedCodeHash: Hex;
    immutableReferences: readonly ByteRange[];
    linkReferences: readonly ByteRange[];
}

export interface FrameworkComponentSpec {
    name: FrameworkDeploymentName;
    normalizedCreationCodeHash: Hex;
    creationLinkReferences: readonly ByteRange[];
    templateTextHash?: Hex;
    runtime:
        | ExactRuntimeVerification
        | NormalizedRuntimeVerification;
    hiddenFromEnvironment: boolean;
}

const staticComponents = {
    SimpleFactory: [
        "0xb9edc85c313403190645581f931075fcd7be32d7683937198454e1b8e0bc47df",
        "0xe5f22f99d0e7fe4e3d8f361afba4d6161d7b009ef2a5aab4325d48fba7e746cc",
    ],
    AllowedCalldataEnforcer: [
        "0x38dbfba3662883b326a2feed3cead4fe93a490e6f25492bbc991ec5ec8bc1b79",
        "0x5c50649f66276cb2625c1544be4355a3a61c72f7db413788df4124da25607128",
    ],
    AllowedTargetsEnforcer: [
        "0xfc2787b7250255c6d274a502e1d8b36ecc7d6743351096366eba1a34372f1804",
        "0xc6e49fa6f963d047b53a6ae22b37838cf74681f15dfa4e085e8716fa8d3157bd",
    ],
    AllowedMethodsEnforcer: [
        "0x162fb6a13b7cc41c0443abd633ef77832109bab1a3dadd4e1aadc6b6e0f6061c",
        "0xeee084c08fbb1c65219c692d22b1b1f22cac91246ca23714b3e29c3ebde6e042",
    ],
    ApprovalRevocationEnforcer: [
        "0x03ed0d65d94b328d4a9ec7e722bdf9ec92b07ef5ef6ad7cb3466e26397c3f606",
        "0xbbef7783a5241cbd3c8074ca23e5f64bb740f228ccb3d6311cf46d97a13fc912",
    ],
    ArgsEqualityCheckEnforcer: [
        "0xe961316a1fe08be9205973874bcb0a9b24b4622f4023541bf20bc514e3107865",
        "0xd298cfc7d590023a19ebc57b88c7377abb88ba00d19c2409ad1505e6fb5c7474",
    ],
    DeployedEnforcer: [
        "0x1c6d891d8c83a5ce299332252ebef3e8a552cafe431105fd8f03de5bea3b2c75",
        "0x8d12de5dadab7cb71de8ebeb59ed89842394f3b319d55808c803da918db59ec4",
    ],
    TimestampEnforcer: [
        "0x574b9de67818caf7103c54d4020381bedf2fb490ef66fdf465f8cafd73d8363b",
        "0x21e584feccaac06d3b3efb9b70a6d69ea1202e8cc58e2f9bdd9c04a84c292b1a",
    ],
    BlockNumberEnforcer: [
        "0x5a4449c8a7f5f6bd8570bc58fb72aa59442e11978f68674e35b6ed48752e3bb4",
        "0xcefb9411aa215db24d873fe26d6b65cb0463ef02cbbaebfc10df2969348d2b67",
    ],
    LimitedCallsEnforcer: [
        "0x139615de6fa6ee219746b61feb8f07db4a8aae5f06ee19f716d17c8a7e4db852",
        "0x52b55dafe005103e5f480023b2b8718185290fef063a8704580db0700ea29631",
    ],
    ERC20BalanceChangeEnforcer: [
        "0xb5804c6afe6abbbcc6c76ef0ff7d743d619fd92e163b615f2201ec8f48892e04",
        "0x7687532da04cb6c2f35809b3c8f0c837aca034895aa7ea4bae10657e6abd02f9",
    ],
    ERC20TransferAmountEnforcer: [
        "0xaf7ac4f88b5f6e442971e88190e7536ab9d5df02681037a3e4aa7bca5bd572fd",
        "0xacea0c86dddcf160a5ec8dc8b91b12064fa9ec0f22058f0bbcc97afc9e0c6128",
    ],
    ERC20StreamingEnforcer: [
        "0x4a6ee2f6904845383ef13592981926e73493e19ea8408420d0eeac7a193feee9",
        "0x8b691a516dc3d7c84f48484816179ee878f7dbc41885cbe8dc671482cb5dc1ac",
    ],
    ERC721BalanceChangeEnforcer: [
        "0xad41aeb122b97416210ffeeadccbfe238ea6707fe49870cf2236970e66a66e05",
        "0x04422a0783febccc9ae172656196e509cfad0dd44d6aafede1702f932aa36237",
    ],
    ERC721TransferEnforcer: [
        "0xb454f9ba4aa3f19c56461656c33aed39c2c367f66c96a5a895cee7801f99ae48",
        "0x668811cf2dd9038261fdfe09f56fdd2a650b6de2bfa0fbd10346e11689178106",
    ],
    ERC1155BalanceChangeEnforcer: [
        "0x5fe2d4ce84cd7f571f0854db48f491ce0f9d10508a31b0357223e55d3425d894",
        "0xd3a5d15a048e95bfb6b2dccac38270b8ef4dfa438d7da87a978fd701bcd54d47",
    ],
    IdEnforcer: [
        "0x98c1388ebdde6fc235d9ec81077734b952a44ea19f144e7fb9f5450daf4c6d47",
        "0xa6229b2d05243a7619781f79758d030aa2faf3dd95d2d570242707b352001b7e",
    ],
    NonceEnforcer: [
        "0xb01009dfc230ad870d1a8e0397ed51af04d8c1144882f62ee5f9c7ee2572c17d",
        "0x17ca7b76a558ebe6860e18fe07ca1bf2712eb12bc3c8ddeb82b7a6e46186bef4",
    ],
    ValueLteEnforcer: [
        "0x9d542e67659a86201de903f52adf3db803ca47bc6a15715ef27eb72c386e4c43",
        "0x28d0d4f406cc5b7b2f1b848e8c0833261f925832225b714052cad12c03ff1d52",
    ],
    NativeTokenTransferAmountEnforcer: [
        "0x834cb8b7afc04b9d9ec50e7e52d606d4b6d2ecdda0893a4e49618d9469829f38",
        "0x0c56766fa64f3f2c3a7156940b4d79307ff3f7dc7f2aae6d84351dc3400a59b1",
    ],
    NativeBalanceChangeEnforcer: [
        "0x34aed3d041a172e6b5606cf5f7c82ce6e096abee7dc0e66c14bcd4bfafffc705",
        "0x77e7f7c540229bd20cacad381feda4701bbb2e579d6c613fa8c7ddbe4904e421",
    ],
    NativeTokenStreamingEnforcer: [
        "0x1cfb00f254013ff2e88bffc6e72f2646268b6513c0ad0f8012d57766b7f29766",
        "0xa1709493c00607dbd48fa043b37a3fa5071203d3f5ade988ba3c1bddb6eefea1",
    ],
    OwnershipTransferEnforcer: [
        "0x732cffbb8de612505cee311b245ff91f0fdf2625883bb543ff5537995b74b0e5",
        "0x6a8c52f0201905239ab9b1814ea32832329c2215d8ca04f60734547d75ba148d",
    ],
    RedeemerEnforcer: [
        "0xbc4d0d01bac5457181585b52dea16c2b17d5701adf52625de734123ba64f67c2",
        "0x1101c320073961d337c545cb685ca647b45e4f90bd2dc55a70883db9205d293b",
    ],
    SpecificActionERC20TransferBatchEnforcer: [
        "0x21ff03355ad2485e64b24666bc87a9e057cfaf33367766c28e52f2f3e422e895",
        "0x42671776863b6e05b6a35f5956bd3cd6bd994a4b72bea97d73cde9b470ef2263",
    ],
    ERC20PeriodTransferEnforcer: [
        "0x31255a95baf79864773e06b7fab02d7f86e15720ab15d2b0c6b808a4de53b760",
        "0xcd8db0c257676feea6d4032ba1385625a0e41fe71b908f6bdb80c8fe22a82019",
    ],
    NativeTokenPeriodTransferEnforcer: [
        "0x09107e0791be2fe69c840de6148b1bf80860f1bff560b13c568bba529af62a77",
        "0xdfeaf263354ddd5ff399fa09dce43d49213e3ab3710d4af2830338b28860203f",
    ],
    ExactCalldataBatchEnforcer: [
        "0x845125a01adfb36ec6ffc20864c6583941930447d9c3a606224a11010ebfd31e",
        "0xf272c03343ac3d77a7383e6b6514721bcf0a16ebb1d3f67c4b6510c4650a0c73",
    ],
    ExactCalldataEnforcer: [
        "0x57770e05d904cd4207bbd636b8b41480f8c066cd7362ce6cc218f6d8e6c73a9f",
        "0x2381fcd0a8f380defaafa9b6a5a6c0aae920d04d2f540e565654f5d62c845fbb",
    ],
    ExactExecutionEnforcer: [
        "0x2e950ac7c53af08498582fbe2006c7c8cc7b4872f13c07bb52adc978081c24cc",
        "0x4d2ff4ec8d486a54dfb583ac24464e108799d49ced35f2bae32c23082f7684af",
    ],
    ExactExecutionBatchEnforcer: [
        "0x8c4a0370ede9217a4f01ccd63680e77760b56e33aa2d804c906a53da80b1c607",
        "0x7f11992d0b946c34a34acd0fe23650930c6f101ad57a732f93ac2f6d1cfade40",
    ],
    MultiTokenPeriodEnforcer: [
        "0x758ea2bcf12def92d7e0cac5232ed8e1abd527f17754dc1801722c2c9bf2d1f0",
        "0x41062583e1a72b59e4d12816be3bdb507d57635fad2e5a41000292fc204292f9",
    ],
} as const satisfies Partial<
    Record<FrameworkDeploymentName, readonly [Hex, Hex]>
>;

const dynamicComponents = {
    SCL_RIP7212: {
        creation:
            "0x3184ebff326e016f18a2f16ab863add3e384dc4558b2733bf5689dc67e4dcdf7",
        runtime:
            "0x18a12aad74e25b7d2d59a6921b7e12d14887eb0b5e3dcb185f94adfaeb8d9730",
        immutableStarts: [],
        // Solidity libraries embed their own deployed address after PUSH20.
        // solc does not report this guard as an immutable reference.
        runtimeImmutableReferences: [{start: 1, length: 20}],
    },
    DelegationManager: {
        creation:
            "0x16c6f93163626c1293bfe2341b3501ca059db8cd184abeae10bad6f26e992653",
        runtime:
            "0x1aaa1c8791064b8055329307cdaebd94cfa9cfd624c44a13938a083691b7bdbe",
        immutableStarts: [6725, 6767, 6809, 6890, 6930, 7085, 7130],
    },
    NativeTokenPaymentEnforcer: {
        creation:
            "0x88d05d26117419969ad5c7033170feb2d956ecba005a1bc99fa61571d3968d1e",
        runtime:
            "0x3d666133a158bcd7577e0b47e2800c1c2d0f6f810d135aef98e43b8fd7e1cca9",
        immutableStarts: [163, 281, 627, 960, 1626],
    },
    HybridDeleGatorImpl: {
        creation:
            "0x619beb9d31212130a79c99009105cd0ade46c69cc243445715674fa626522b40",
        templateTextHash:
            "0x67f580878a56b3a534d59fe6fa5e5d6ef29da37749cbb163006a8e4b4468e7f5",
        creationLinkReferences: [{start: 14415, length: 20}],
        runtime:
            "0x05a6f3df20d0c21d53fbeda9fd9706ddf189a6cd2f589cd8ba35380e5a146be5",
        immutableStarts: [
            1676, 2047, 2334, 2507, 2750, 2876, 2975, 3106, 3232, 3331, 3413,
            3552, 3664, 3900, 4087, 4201, 4803, 4930, 5035, 5134, 5286, 5477,
            6060, 6683, 7438, 7548, 7793, 7835, 7877, 7958, 7998, 8592, 8633,
            9744, 10029, 10074, 11598,
        ],
        runtimeLinkReferences: [{start: 12757, length: 20}],
    },
    MultiSigDeleGatorImpl: {
        creation:
            "0x6b5e983dfaef1fa2faacab260f66228c93270aef9c83d443d7a7bc45e9041cd1",
        runtime:
            "0xb4b472e41378723163bbc2de8bcfbe751ec8db0c6912decece62d04814daedf8",
        immutableStarts: [
            1752, 2122, 2509, 3117, 3255, 3381, 3480, 3611, 3737, 3836, 3918,
            4057, 4446, 4686, 4865, 4979, 5411, 5538, 5637, 5789, 5857, 6485,
            6731, 7265, 7780, 8410, 8520, 8561, 8689, 8731, 8773, 8854, 8894,
            9841, 10602, 10647, 11533,
        ],
    },
    EIP7702StatelessDeleGatorImpl: {
        creation:
            "0x7af2e1a25716422aadfc9dd563a5134290a122488491e3d265066703d801391d",
        runtime:
            "0x201a45b6a8dd555051309d6ff21b2fd410e4462d4b348cd9fb2748743d3d5046",
        immutableStarts: [
            1137, 1402, 1561, 1850, 1942, 2039, 2111, 2242, 2368, 2467, 2598,
            2724, 2823, 2886, 2970, 3058, 3188, 3302, 3495, 3600, 3727, 3826,
            4117, 4185, 4813, 5582, 5665, 5759, 5801, 5843, 5924, 5964, 6451,
            6496,
        ],
    },
} as const satisfies Partial<
    Record<
        FrameworkDeploymentName,
        {
            creation: Hex;
            runtime: Hex;
            immutableStarts: readonly number[];
            runtimeImmutableReferences?: readonly ByteRange[];
            templateTextHash?: Hex;
            creationLinkReferences?: readonly ByteRange[];
            runtimeLinkReferences?: readonly ByteRange[];
        }
    >
>;

function byteRanges(starts: readonly number[]): ByteRange[] {
    return starts.map((start) => ({start, length: 32}));
}

function buildComponentSpec(name: FrameworkDeploymentName): FrameworkComponentSpec {
    const staticSpec = staticComponents[name as keyof typeof staticComponents] as
        | readonly [Hex, Hex]
        | undefined;
    if (staticSpec) {
        return {
            name,
            normalizedCreationCodeHash: staticSpec[0],
            creationLinkReferences: [],
            runtime: {kind: "exact", codeHash: staticSpec[1]},
            hiddenFromEnvironment: name === "SCL_RIP7212",
        };
    }

    const dynamicSpec = dynamicComponents[name as keyof typeof dynamicComponents] as
        | {
              creation: Hex;
              runtime: Hex;
              immutableStarts: readonly number[];
              runtimeImmutableReferences?: readonly ByteRange[];
              templateTextHash?: Hex;
              creationLinkReferences?: readonly ByteRange[];
              runtimeLinkReferences?: readonly ByteRange[];
          }
        | undefined;
    if (!dynamicSpec) throw new Error(`missing Framework component specification: ${name}`);
    return {
        name,
        normalizedCreationCodeHash: dynamicSpec.creation,
        creationLinkReferences: dynamicSpec.creationLinkReferences ?? [],
        ...(dynamicSpec.templateTextHash
            ? {templateTextHash: dynamicSpec.templateTextHash}
            : {}),
        runtime: {
            kind: "normalized",
            normalizedCodeHash: dynamicSpec.runtime,
            immutableReferences: [
                ...byteRanges(dynamicSpec.immutableStarts),
                ...(dynamicSpec.runtimeImmutableReferences ?? []),
            ],
            linkReferences: dynamicSpec.runtimeLinkReferences ?? [],
        },
        hiddenFromEnvironment: name === "SCL_RIP7212",
    };
}

export const FRAMEWORK_COMPONENTS = FRAMEWORK_DEPLOYMENT_ORDER.map(buildComponentSpec);

export const FRAMEWORK_COMPONENT_BY_NAME = Object.fromEntries(
    FRAMEWORK_COMPONENTS.map((component) => [component.name, component]),
) as Record<FrameworkDeploymentName, FrameworkComponentSpec>;

export const GIWA_ENTRY_POINT_V07_IDENTITY = {
    address: ENTRY_POINT_V07,
    senderCreator: getAddress("0xEFC2c1444eBCC4Db75e7613d20C6a62fF67A167C"),
    version: "0.7.0",
    runtimeCodeHash:
        "0x8db5ff695839d655407cc8490bb7a5d82337a86a6b39c3f0258aa6c3b582fc58" as Hex,
    sourceRevision: "7af70c8993a6f42973f520ae0752386a5032abe7",
    compiler: {
        version: "0.8.23+commit.f704f362",
        evmVersion: "paris",
        viaIR: true,
        optimizerRuns: 1_000_000,
    },
    source:
        "https://docs.giwa.io/giwa-chain/en/network-information/contracts",
} as const;

export const FRAMEWORK_UPSTREAM = {
    smartAccountsKit: {
        version: "1.7.0",
        sourceRevision: "d90569fa7c045d65b57d615ff2576ae2561f3022",
        npmIntegrity:
            "sha512-zypiFPDkJ12fpXENmPIqFQr4H35b3LttwIhB+PfQpP9sGHWKUIz0CnhSurkl6vZ6GyKC+RNcl0Kq0QyPqSExXQ==",
    },
    delegationAbis: {
        version: "1.1.0",
        npmIntegrity:
            "sha512-n7XgRAM+pKUqmw4X+nAxM9a9HTBGe049WCAbpnHV6WoT6JnHhurMSUiqpAwMh69RhEykBtJPYSVPTVlJu6pEPg==",
    },
    delegationCore: {
        version: "2.2.1",
        npmIntegrity:
            "sha512-fpB25AgmBxTJYhHj92tFS4dJe63x6wz71c8dPTwUin12dAvFMWM3PH+rm4C34iPb5ZrQzkAPi4e9z2njmwEZUA==",
    },
    delegationDeployments: {
        version: "1.4.0",
        npmIntegrity:
            "sha512-QuO4Fiz3GsP7nwcUpXFEVTxmRGBTkriYeZ7DBLxUAqbUQx7Kg630eR1SgvTn/eBMkmXB2tZJW9am/iGuAcySlw==",
    },
    delegationCompiler: {
        version: "0.8.23+commit.f704f362",
        evmVersion: "london",
        viaIR: false,
        optimizerRuns: 200,
        metadataBytecodeHash: "ipfs",
    },
    delegationFrameworkRevision: "d0ebab5386503824730fdc0e48924f362d8290d0",
    openZeppelinRevision: "105fa4e1b0832a6a40cb7ba6e545bb844f02a711",
} as const;

function componentHashMaterial(component: FrameworkComponentSpec): string {
    const runtime =
        component.runtime.kind === "exact"
            ? `exact:${component.runtime.codeHash}`
            : [
                  "normalized",
                  component.runtime.normalizedCodeHash,
                  ...component.runtime.immutableReferences.map(
                      ({start, length}) => `i${start}:${length}`,
                  ),
                  ...component.runtime.linkReferences.map(
                      ({start, length}) => `l${start}:${length}`,
                  ),
              ].join(":");
    return [
        component.name,
        component.normalizedCreationCodeHash,
        component.templateTextHash ?? "",
        `hidden:${String(component.hiddenFromEnvironment)}`,
        ...component.creationLinkReferences.map(
            ({start, length}) => `c${start}:${length}`,
        ),
        runtime,
    ].join(":");
}

const compositionMaterial = [
    FRAMEWORK_UPSTREAM.smartAccountsKit.version,
    FRAMEWORK_UPSTREAM.smartAccountsKit.sourceRevision,
    FRAMEWORK_UPSTREAM.smartAccountsKit.npmIntegrity,
    FRAMEWORK_UPSTREAM.delegationAbis.version,
    FRAMEWORK_UPSTREAM.delegationAbis.npmIntegrity,
    FRAMEWORK_UPSTREAM.delegationCore.version,
    FRAMEWORK_UPSTREAM.delegationCore.npmIntegrity,
    FRAMEWORK_UPSTREAM.delegationDeployments.version,
    FRAMEWORK_UPSTREAM.delegationDeployments.npmIntegrity,
    FRAMEWORK_UPSTREAM.delegationCompiler.version,
    FRAMEWORK_UPSTREAM.delegationCompiler.evmVersion,
    String(FRAMEWORK_UPSTREAM.delegationCompiler.viaIR),
    String(FRAMEWORK_UPSTREAM.delegationCompiler.optimizerRuns),
    FRAMEWORK_UPSTREAM.delegationCompiler.metadataBytecodeHash,
    FRAMEWORK_UPSTREAM.delegationFrameworkRevision,
    FRAMEWORK_UPSTREAM.openZeppelinRevision,
    GIWA_ENTRY_POINT_V07_IDENTITY.address,
    GIWA_ENTRY_POINT_V07_IDENTITY.senderCreator,
    GIWA_ENTRY_POINT_V07_IDENTITY.version,
    GIWA_ENTRY_POINT_V07_IDENTITY.runtimeCodeHash,
    GIWA_ENTRY_POINT_V07_IDENTITY.sourceRevision,
    GIWA_ENTRY_POINT_V07_IDENTITY.compiler.version,
    GIWA_ENTRY_POINT_V07_IDENTITY.compiler.evmVersion,
    String(GIWA_ENTRY_POINT_V07_IDENTITY.compiler.viaIR),
    String(GIWA_ENTRY_POINT_V07_IDENTITY.compiler.optimizerRuns),
    GIWA_ENTRY_POINT_V07_IDENTITY.source,
    ...FRAMEWORK_COMPONENTS.map(componentHashMaterial),
].join("|");

export const FRAMEWORK_COMPOSITION_SPEC_HASH = keccak256(
    stringToHex(compositionMaterial),
);

export const FRAMEWORK_COMPOSITION_ID =
    `mapae-sak-1.7.0-d90569fa-df-d0ebab53-${FRAMEWORK_COMPOSITION_SPEC_HASH.slice(2, 10)}` as const;

function exportName(name: FrameworkDeploymentName): string {
    return name.endsWith("Impl") ? name.slice(0, -"Impl".length) : name;
}

export function frameworkCreationBytecodeTemplate(
    name: FrameworkDeploymentName,
): string {
    const exports = DelegationBytecodes as unknown as Record<string, unknown>;
    const value = exports[exportName(name)];
    if (typeof value !== "string" || value.length < 4) {
        throw new Error(`installed bytecode export is missing for ${name}`);
    }
    return value;
}

/**
 * Replace compiler-declared immutable or library reference bytes with zeroes.
 * This lets the verifier compare code shape while checking the removed values
 * separately through constructor records and live getters.
 */
export function normalizeBytecode(
    value: string,
    ranges: readonly ByteRange[],
): Hex {
    const body = value.startsWith("0x") ? value.slice(2) : value;
    if (body.length % 2 !== 0) throw new Error("bytecode must contain complete bytes");
    const characters = body.split("");
    const byteLength = body.length / 2;
    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    let previousEnd = 0;
    for (const {start, length} of sorted) {
        if (
            !Number.isInteger(start) ||
            !Number.isInteger(length) ||
            start < previousEnd ||
            length < 1 ||
            start + length > byteLength
        ) {
            throw new Error("invalid or overlapping bytecode reference range");
        }
        characters.fill("0", start * 2, (start + length) * 2);
        previousEnd = start + length;
    }
    const normalized = `0x${characters.join("")}`;
    if (!isHex(normalized, {strict: true})) {
        throw new Error("bytecode outside declared link ranges is not hex");
    }
    return normalized;
}

export function normalizedCreationCodeHash(
    component: FrameworkComponentSpec,
    bytecode: string,
): Hex {
    return keccak256(normalizeBytecode(bytecode, component.creationLinkReferences));
}

export function identifyFrameworkDeploymentBytecode(
    bytecode: string,
): FrameworkDeploymentName {
    const matches = FRAMEWORK_COMPONENTS.filter((component) => {
        try {
            return (
                normalizedCreationCodeHash(component, bytecode) ===
                component.normalizedCreationCodeHash
            );
        } catch {
            // A reference range outside this candidate bytecode means the
            // candidate cannot be this component.
            return false;
        }
    });
    if (matches.length !== 1) {
        throw new Error(
            matches.length === 0
                ? "deployment bytecode is not in the pinned Framework composition"
                : "deployment bytecode ambiguously matches multiple Framework components",
        );
    }
    const match = matches[0];
    if (!match) throw new Error("Framework bytecode match disappeared");
    return match.name;
}

export function assertInstalledFrameworkBytecodes(): void {
    if (FRAMEWORK_COMPONENTS.length !== FRAMEWORK_DEPLOYMENT_COUNT) {
        throw new Error(`Framework composition must contain ${FRAMEWORK_DEPLOYMENT_COUNT} units`);
    }
    for (const component of FRAMEWORK_COMPONENTS) {
        const bytecode = frameworkCreationBytecodeTemplate(component.name);
        const actual = normalizedCreationCodeHash(component, bytecode);
        if (actual !== component.normalizedCreationCodeHash) {
            throw new Error(`installed creation bytecode mismatch for ${component.name}`);
        }
        if (
            component.templateTextHash &&
            keccak256(stringToHex(bytecode)) !== component.templateTextHash
        ) {
            throw new Error(`installed linked bytecode template mismatch for ${component.name}`);
        }
    }
}

export function verifyFrameworkRuntimeCode(
    name: FrameworkDeploymentName,
    code: Hex,
): {codeHash: Hex; normalizedCodeHash: Hex} {
    if (code === "0x") throw new Error(`${name} has no runtime code`);
    const component = FRAMEWORK_COMPONENT_BY_NAME[name];
    const codeHash = keccak256(code);
    const normalized =
        component.runtime.kind === "exact"
            ? code
            : normalizeBytecode(code, [
                  ...component.runtime.immutableReferences,
                  ...component.runtime.linkReferences,
              ]);
    const normalizedCodeHash = keccak256(normalized);
    const expected =
        component.runtime.kind === "exact"
            ? component.runtime.codeHash
            : component.runtime.normalizedCodeHash;
    if (normalizedCodeHash !== expected) {
        throw new Error(`${name} runtime code does not match the pinned composition`);
    }
    return {codeHash, normalizedCodeHash};
}

export function extractRuntimeLinkAddresses(
    name: FrameworkDeploymentName,
    code: Hex,
): Address[] {
    const component = FRAMEWORK_COMPONENT_BY_NAME[name];
    if (component.runtime.kind === "exact") return [];
    const body = code.slice(2);
    return component.runtime.linkReferences.map(({start, length}) => {
        if (length !== 20 || start * 2 + length * 2 > body.length) {
            throw new Error(`${name} has an unsupported runtime link reference`);
        }
        return getAddress(`0x${body.slice(start * 2, (start + length) * 2)}`);
    });
}

export function verifySclRuntimeSelfAddress(code: Hex, addressInput: Address): void {
    const address = getAddress(addressInput);
    const component = FRAMEWORK_COMPONENT_BY_NAME.SCL_RIP7212;
    if (component.runtime.kind !== "normalized") {
        throw new Error("SCL_RIP7212 must use normalized runtime verification");
    }
    const [reference] = component.runtime.immutableReferences;
    if (!reference || reference.length !== 20) {
        throw new Error("SCL_RIP7212 self-address reference is not pinned");
    }
    const body = code.slice(2);
    const embedded = getAddress(
        `0x${body.slice(reference.start * 2, (reference.start + reference.length) * 2)}`,
    );
    if (embedded !== address) {
        throw new Error("SCL_RIP7212 runtime self-address mismatch");
    }
}

export function verifyGiwaEntryPointRuntimeCode(code: Hex): Hex {
    if (code === "0x") throw new Error("GIWA EntryPoint v0.7.0 has no runtime code");
    const codeHash = keccak256(code);
    if (codeHash !== GIWA_ENTRY_POINT_V07_IDENTITY.runtimeCodeHash) {
        throw new Error("GIWA EntryPoint v0.7.0 runtime identity mismatch");
    }
    return codeHash;
}
