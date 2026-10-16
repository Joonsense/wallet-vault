# wallet-vault (`wv`)

메인넷 개인 지갑을 몇 초 만에 만들고, 개인키·니모닉을 로컬 암호화 볼트에 보관하는 CLI.
EVM(이더리움·Base·Arbitrum·BNB 등 전부 같은 키) + Solana 를 니모닉 하나로 파생한다.

## 설치

```bash
pnpm install
ln -sf "$PWD/src/cli.mjs" ~/.local/bin/wv   # 전역 명령
```

## 사용

```bash
wv new trader1                    # 24단어 니모닉 → EVM + Solana 주소, 볼트에 암호화 저장
wv new --chain evm --count 3 bot  # EVM 전용 3개 (bot-1, bot-2, bot-3)
wv list                           # 주소만 표시, 비밀은 절대 안 나옴
wv show trader1 --index 1         # 같은 니모닉의 1번 계정 주소
wv export trader1 --mnemonic      # 니모닉 오프라인 백업용 (reveal 타이핑 확인)
wv export trader1 --evm           # EVM 개인키
wv export trader1 --sol           # Solana 비밀키 (Phantom 가져오기 형식, base58 64바이트)
eval "$(wv env trader1)"          # 현재 셸에 EVM_PRIVATE_KEY / SOL_SECRET_KEY 주입 (봇 실행용)
wv import cold --mnemonic         # 기존 니모닉 가져오기 (숨김 프롬프트로 입력, 인자로 넘기면 거부)
wv import hot --evm               # 원시 개인키 가져오기 (--sol 은 base58 또는 JSON 배열)
wv rm trader1                     # 라벨 타이핑 확인 후 삭제
wv passwd                         # 볼트 암호 교체 (항상 프롬프트, WV_PASSPHRASE 무시, 같은 암호 거부)
wv backup ~/Backups/vault.json    # 암호화된 상태로 복사
wv balance trader1                # 8개 체인 네이티브 잔고 병렬 조회 (--chain base,sol / --json / --index N)
wv send trader1 --chain base --to 0x... --amount 0.01 --dry-run   # 수수료·잔고 미리보기만
wv send trader1 --chain sol --to <addr> --amount 0.1              # "send" 타이핑 확인 후 브로드캐스트
```

## 체인

| 키 | 체인 | 네이티브 | 기본 RPC |
| --- | --- | --- | --- |
| eth | Ethereum | ETH | viem 기본 공개 RPC |
| base | Base | ETH | mainnet.base.org |
| arb | Arbitrum One | ETH | arb1.arbitrum.io |
| op | OP Mainnet | ETH | mainnet.optimism.io |
| bnb | BNB Chain | BNB | viem 기본 공개 RPC |
| polygon | Polygon PoS | POL | viem 기본 공개 RPC |
| avax | Avalanche C | AVAX | api.avax.network |
| sol | Solana | SOL | api.mainnet-beta.solana.com |

테스트넷: `sepolia`, `base-sepolia`, `arb-sepolia`, `op-sepolia`, `bnb-testnet`, `amoy`, `fuji`, `sol-devnet`.
`--chain all` 은 메인넷만, `--chain testnets` 는 테스트넷만, `--chain everything` 은 둘 다. send 미리보기 첫 줄에 MAINNET / testnet 이 표시된다.

```bash
wv faucet test1 --chain sol-devnet --amount 1   # devnet 에어드롭 (공개 RPC 한도 초과 시 faucet.solana.com 안내)
wv faucet test1 --chain base-sepolia            # EVM 테스트넷은 주소 + 웹 faucet 주소 출력
wv send test1 --chain sol-devnet --to <addr> --amount 0.1
```

공개 RPC 는 속도 제한이 있으니 자주 쓰면 `WV_RPC_BASE=https://...` 처럼 체인별 RPC 를 .env 에 넣는다 (하이픈은 밑줄로, 예 `WV_RPC_SOL_DEVNET`). 별칭: ethereum, arbitrum, optimism, bsc, matic, solana.

### send 안전장치

- EVM 주소는 체크섬 불일치면 거부, Solana 주소는 base58 공개키 검증.
- 보내기 전 수수료(EVM maxFee × gas, SOL getFeeForMessage)·잔고 변화·경고를 보여주고, 잔고 부족이면 브로드캐스트 전에 중단.
- 수신자가 컨트랙트면 경고, Solana 새 계정이면 rent exempt 최소액 미만 경고.
- `--dry-run` 은 서명·전송 없이 미리보기만. `--yes` 없이는 "send" 를 타이핑해야 나간다.
- 네이티브 토큰만. ERC-20·SPL 토큰 전송은 없다.

## Hyperliquid API 지갑 (agent wallet)

HL 봇은 메인 계정 키 대신 메인이 승인한 agent 키로 서명한다. agent 는 거래만 하고 출금은 못 한다.
wv 는 agent 키 생성 → 볼트 저장 → 메인 키로 approveAgent EIP-712 서명·제출을 한 명령으로 한다.

```bash
wv hl agents main --testnet                      # 승인된 agent 목록 + 만료, 볼트에 키가 있는지 표시
wv hl new-agent main --name swan --days 30       # 새 키 생성 + 승인 (메인넷, "approve" 타이핑 확인)
wv hl approve main --agent 7 --name swan         # 볼트의 기존 키 승인
eval "$(wv env hl-swan)"                         # 봇에는 agent 키만 주입, 계정 조회는 메인 주소로
```

규칙 (HL 문서 기준): 계정당 unnamed 1개 + named 3개, named 는 `--days` 로 최대 180일 만료 지정. 같은 이름으로 다시 승인하면 이전 agent 가 해제된다.
한 번 쓰고 해제된 agent 주소는 nonce 집합이 정리돼 재승인 시 과거 서명이 재생될 수 있으므로 재사용하지 않는다. `new-agent` 가 항상 새 키를 만드는 이유다.
승인이 거절돼도 agent 키는 볼트에 남고 note 에 사유가 기록된다 (예: 메인이 HL 에 입금한 적 없으면 "Must deposit before performing actions").

## 보관 방식

| 항목 | 값 |
| --- | --- |
| 볼트 위치 | `~/.wallet-vault/vault.json` (`WV_VAULT` 로 변경), 권한 600 |
| 키 파생 | scrypt N=2^17 r=8 p=1, 볼트당 salt 32바이트 |
| 암호화 | AES-256-GCM, 지갑 항목마다 별도 iv·tag |
| HL 서명 | @nktkas/hyperliquid ExchangeClient (viem 계정), 메인넷 api.hyperliquid.xyz / 테스트넷 api.hyperliquid-testnet.xyz |
| 암호 입력 | 숨김 프롬프트, 또는 `WV_PASSPHRASE` 환경변수 (.env 에만, 커밋 금지) |
| 파생 경로 | EVM `m/44'/60'/0'/0/i`, Solana `m/44'/501'/i'/0'` (MetaMask·Phantom 과 동일) |

주소 외의 비밀은 `export` 와 `env` 두 명령에서만 stdout 으로 나오고, 그때마다 stderr 에 경고가 붙는다.
볼트 파일과 암호를 같은 곳에 두지 말 것. 볼트 파일만 유출돼도 암호 없이는 열리지 않지만, 암호가 약하면 의미가 없다.

## 검증

```bash
pnpm test    # BIP-44 / SLIP-0010 공개 테스트 벡터 + 볼트 암복호화·암호 교체
```
