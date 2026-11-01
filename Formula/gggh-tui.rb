class GgghTui < Formula
  desc "Terminal app for GGGH: monitor and control your cloud gaming machines"
  homepage "https://github.com/reganireland-source/cloudgaming/tree/main/tui"
  url "https://github.com/reganireland-source/cloudgaming/archive/ccb0ae1b3e32e5ff41e610434aad8842a9ecb287.tar.gz"
  version "0.3.1"
  sha256 "229a5f41207ddcc3a478a4259eed9a906afddbafa3c1916adbe72f8b676fdeff"
  head "https://github.com/reganireland-source/cloudgaming.git", branch: "main"

  depends_on "go" => :build

  def install
    cd "tui" do
      system "go", "build", *std_go_args(ldflags: "-s -w -X main.version=#{version}")
    end
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/gggh-tui --version")
  end
end
